import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

// -----------------------------
// Environment variables
// -----------------------------
const {
  MONGO_URI,
  MONGO_DB,
  MONGO_COLLECTION,
  GEMINI_API_KEY,
  VECTOR_SEARCH_INDEX_NAME,
  ALLOWED_ORIGIN,
  PORT
} = process.env;

if (!MONGO_URI || !GEMINI_API_KEY || !MONGO_DB || !MONGO_COLLECTION || !VECTOR_SEARCH_INDEX_NAME) {
  console.error("❌ Fatal Error: Missing required environment variables!");
  console.error("Please check MONGO_URI, MONGO_DB, MONGO_COLLECTION, GEMINI_API_KEY, and VECTOR_SEARCH_INDEX_NAME.");
  process.exit(1);
}

// -----------------------------
// Express app setup
// -----------------------------
const app = express();
app.use(express.json());

const corsOptions = {
  origin: ALLOWED_ORIGIN,
  methods: ["POST","GET"],
  credentials: true,
};
app.use(cors(corsOptions));
console.log(`CORS enabled for origin: ${corsOptions.origin}`);

// -----------------------------
// MongoDB connection
// -----------------------------
const client = new MongoClient(MONGO_URI);
let collection;

async function connectDB() {
  await client.connect();
  const db = client.db(MONGO_DB);
  collection = db.collection(MONGO_COLLECTION);
  console.log("Connected to MongoDB");
}

// -----------------------------
// Google Gen AI SDK setup
// -----------------------------
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

console.log("Google Gen AI client initialized");

// -----------------------------
// Utility: sanitize user input
// -----------------------------
function sanitizeInput(text) {
  if (typeof text !== 'string') return "";
  return text
    .replace(/<[^>]*>?/gm, "")      // Strip HTML tags
    .replace(/[{}[\]();<>]/g, "") // Remove potentially harmful characters
    .replace(/[^a-zA-Z0-9\s.,!?'-]/g, "") // Allow basic punctuation
    .trim();
}

// -----------------------------
// API endpoints
// -----------------------------
app.get("/", (_req, res) => {
  res.send("Shadows Fate AI server is running! Go back Nothing here");
});

app.post("/query", async (req, res) => {
  try {
    const userQuery = sanitizeInput(req.body.query);
    if (!userQuery) {
      console.log("Empty query received.");
      return res.status(400).json({ error: "Empty query." });
    }
    console.log(`Processing query: "${userQuery}"`);

    // --- 1. Embed the query using the embedContent method ---
    console.log("1. Embedding query...");
    const embedResp = await ai.models.embedContent({
      model: "gemini-embedding-001",
      contents: userQuery,
      // optional requestOptions, e.g. timeout
      requestOptions: { timeout: 30000 }
    });
    const queryEmbedding = embedResp.embeddings?.[0]?.values;
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) { 
      console.error("--- DEBUG: EMBEDDING RESPONSE MISSING VALUES ---"); 
      throw new Error("Embedding failed: the response contained an empty or invalid embedding vector. Please check the raw response above for API error messages.");
    }
    console.log("2. Embedding successful.");

    // --- 2. Vector search in MongoDB ---
    const aggPipeline = [
      {
        $vectorSearch: {
          index: VECTOR_SEARCH_INDEX_NAME,
          path: "embedding",
          queryVector: queryEmbedding,
          numCandidates: 200,
          limit: 5
        }
      },
      {
        $project: {
          _id: 1,
          title: 1,
          content: 1,
          score: { $meta: "vectorSearchScore" }
        }
      }
    ];
    const docs = await collection.aggregate(aggPipeline).toArray();

    let context;
    
    if (!docs.length) {
      console.log("No relevant documents found. Proceeding without context.");
      context = "";
    } else {
      console.log(`Found ${docs.length} relevant documents.`);
      context = docs.map((d,i) => `Source ${i+1} (Score: ${d.score.toFixed(2)}): ${d.content}`).join("\n\n");
    }

    // --- 3. Build prompt with RAG style ---
    const ragPrompt = `
      You are a Shadow Fight expert assistant. Use the retrieved context as your factual base.
      Follow this reasoning pipeline:
      1. **Extract Key Facts**
        - Summarize only the relevant details from the provided context
        - Do NOT hallucinate anything not present

      2. **Deep Reasoning**
        - understand what user is trying to get & answer that with more explainantion with the given context
        - Use step-by-step logic
        - Make deductions even if not directly stated, but ONLY from the given info

      3. **Final Answer (Clean & User-Friendly)**
        - Provide a formatted, readable answer
        - Include bullet points, highlights where useful
        - Avoid showing your reasoning steps
        - Avoid words like based on context instead say from my knowledge
      **Context:**
      ---
      ${context}
      ---

      **User Question:**
      "${userQuery}"
      `;

    // --- 4. Ask the model to generate content using new style ---
    console.log("3. Generating content...");
    const generationConfig = {
      temperature: 0.2,
      topK: 1,
      topP: 0.9
    };

    const safetySettings = [
      { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ];

    const genResp = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: ragPrompt }] }],
      generationConfig,
      safetySettings,
      requestOptions: { timeout: 30000 }
    });
    const llmResponse = genResp.text;
    if (!llmResponse) {
      throw new Error("Failed to generate content: no text in response");
    }
    console.log("4. Content generation successful.");

    console.log("Sending LLM response.");
    res.json({ response: llmResponse });

  } catch (err) {
    console.error("❌ Error in /query endpoint:", err.message);
    //res.status(400).json({ error: "An error occurred while processing the query."});

    let apiStatus = null;
    try {
      // The error message from the SDK often contains a JSON string of the API error
      const errorJsonMatch = err.message.match(/(\{.*?\})/s);
      if (errorJsonMatch && errorJsonMatch[0]) {
        const apiError = JSON.parse(errorJsonMatch[0]);
        // Extract the error status field from the nested JSON structure
        apiStatus = apiError.error?.status || null;
      }
    } catch (parseErr) {
      // If parsing fails, we assume it's a non-API-related error (e.g., MongoDB, network)
      console.warn("Failed to parse error message for specific API status:", parseErr.message);
    }

    // Use a switch case on the extracted API status for specific handling
    switch (apiStatus) {
      case 'RESOURCE_EXHAUSTED':
      case 'UNAVAILABLE':
        // Handle 429 (Too Many Requests) or service unavailability
        return res.status(429).json({
          error: "Service Capacity Reached",
          message: "The AI service is currently overloaded. Please try your query again in a few moments."
        });

      case 'INVALID_ARGUMENT':
        // Handle 400 (Bad Request) - often due to malformed input or safety violations
        return res.status(400).json({
          error: "Invalid Request Content",
          message: "The AI service rejected the prompt due to invalid format or safety concerns. Please refine your query."
        });

      case 'PERMISSION_DENIED':
      case 'UNAUTHENTICATED':
        // Handle 401/403 (Auth/API Key issue)
        return res.status(403).json({
          error: "Server Configuration Error",
          message: "Authentication failed."
        });

      default:
        // Check for manually thrown errors (like embedding failure)
        if (err.message.includes("Embedding failed") || err.message.includes("Failed to generate content")) {
          return res.status(500).json({
            error: "Internal AI Processing Failure",
            message: "Please contact the server administrator with screenshot."
          });
        }

        // Default catch-all for unknown errors (e.g., MongoDB disconnection, network issues)
        return res.status(500).json({
          error: "Internal Server Error",
          message: "An unexpected error occurred. Please try your query again after a short delay."
        });
    }
  }
});

// -----------------------------
// Server startup
// -----------------------------
async function startServer() {
  try {
    await connectDB();
    const port = PORT || 8000;
    app.listen(port, "0.0.0.0", () => {
      console.log(`🚀 Server listening on http://0.0.0.0:${port}`);
    });
  } catch (err) {
    console.error("❌ Failed to start the server:", err.message);
    process.exit(1);
  }
}


startServer();




