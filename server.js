import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "@google/generative-ai";
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
  process.exit(1); // Exit the process with an error code
}

// -----------------------------
// Express app setup
// -----------------------------
const app = express();
app.use(express.json());

// A flexible CORS setup for production and development
const corsOptions = {
  origin: ALLOWED_ORIGIN || "*", // Fallback to allow all, but ALLOWED_ORIGIN is safer
  methods: ["POST", "GET"],
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
  // This will throw an error if connection fails, which will be caught by startServer
  await client.connect();
  const db = client.db(MONGO_DB);
  collection = db.collection(MONGO_COLLECTION);
  console.log("Connected to MongoDB Atlas");
}

// -----------------------------
// Gemini API setup
// -----------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "embedding-001" }); // Adjusted model name
const chatModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Adjusted to a common flash model
console.log("Gemini AI models initialized");

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
app.get("/", (req, res) => {
  res.send("Shadows Fate AI server is running!");
});

app.post("/query", async (req, res) => {
  try {
    const userQuery = sanitizeInput(req.body.query || "");
    if (!userQuery) {
      console.log("Empty query received.");
      return res.status(400).json({ error: "Empty query." });
    }
    console.log(`Processing query: "${userQuery}"`);

    // 1. Embed query
    const { embedding } = await embeddingModel.embedContent(userQuery);

    // 2. Perform vector search
    const aggPipeline = [
      {
        $vectorSearch: {
          index: VECTOR_SEARCH_INDEX_NAME,
          path: "embedding",
          queryVector: embedding.values,
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
    
    if (!docs.length) {
      console.log("No relevant documents found.");
      return res.status(404).json({ response: "I couldn't find any relevant information for that query." });
    }
    console.log(`Found ${docs.length} relevant documents.`);

    // 3. Combine retrieved chunks
    const context = docs.map((d, i) => `Source ${i + 1} (Score: ${d.score.toFixed(2)}): ${d.text}`).join("\n\n");

    // 4. Ask Gemini
    const chat = chatModel.startChat({
      generationConfig: {
        temperature: 0.2,
        topK: 1,
        topP: 0.9,
      },
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
      ],
    });

    const ragPrompt = `
You are a helpful expert on the Shadow Fight game series.
Your task is to answer the user's question based *only* on the context provided below.
Do not use any outside knowledge. If the context does not contain the answer, say so.

**Context:**
---
${context}
---

**User Question:**
"${userQuery}"

**Your Answer:**
(Provide a clear, concise answer in Markdown format, citing sources if helpful, e.g., "According to Source 1...")
`;

    const result = await chat.sendMessage(ragPrompt);
    const llmResponse = result.response.text();
    console.log("Sending LLM response.");
    res.json({ response: llmResponse });

  } catch (err) {
    console.error("❌ Error in /query endpoint:", err.message, err.stack);
    res.status(500).json({ error: "An error occurred while processing the query." });
  }
});

// -----------------------------
// Server startup
// -----------------------------
async function startServer() {
  try {
    // 1. Connect to the database
    await connectDB();
    
    // 2. Start the Express server *only after* DB is connected
    const port = PORT || 8000;
    app.listen(port, "0.0.0.0", () => {
      console.log(`🚀 Server listening on http://0.0.0.0:${port}`);
    });
  } catch (err) {
    console.error("❌ Failed to start the server:", err.message, err.stack);
    process.exit(1); // Exit process with failure
  }
}

// Start the server
startServer();
