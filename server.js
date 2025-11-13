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
          text: 1,
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
      context = docs.map((d,i) => `Source ${i+1} (Score: ${d.score.toFixed(2)}): ${d.text}`).join("\n\n");
    }

    // --- 3. Build prompt with RAG style ---
    const ragPrompt = `
      You are a helpful expert on the Shadow Fight game series.
      Use *only* the context below to answer. If the answer isn't in the context, say no info.

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
    res.status(500).json({ error: "An error occurred while processing the query."});
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