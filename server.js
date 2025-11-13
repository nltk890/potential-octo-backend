import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import axios from "axios";
import { sanitizeInput } from "./utils/sanitize.js";

dotenv.config();

const app = express();
app.use(express.json());

// -----------------------------
// Secure CORS
// -----------------------------
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN,
    methods: ["POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// -----------------------------
// MongoDB Connection
// -----------------------------
const client = new MongoClient(process.env.MONGO_URI);
let collection;

async function connectDB() {
  await client.connect();
  const db = client.db(process.env.MONGO_DB);
  collection = db.collection(process.env.MONGO_COLLECTION);
  console.log("✅ MongoDB Connected");
}
connectDB();

// -----------------------------
// Retrieve Top K Using MongoDB Vector Search
// -----------------------------
async function retrieveTopK(queryEmbedding, topK = 5) {
  const pipeline = [
    {
      $vectorSearch: {
        index: "vector_index", // name of your vector index in Atlas
        path: "embedding",
        queryVector: queryEmbedding,
        numCandidates: 100,
        limit: topK,
      },
    },
    {
      $project: {
        text: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];

  const results = await collection.aggregate(pipeline).toArray();
  return results.map(r => r.text);
}

// -----------------------------
// Generate Embedding using Gemini (or fallback model if needed)
// -----------------------------
async function embedText(text) {
  try {
    const response = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/textembedding-gecko-002:embedText",
      { text },
      { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } }
    );
    return response.data.embedding.values;
  } catch (error) {
    console.error("Embedding error:", error.response?.data || error.message);
    throw new Error("Failed to create embedding.");
  }
}

// -----------------------------
// Call Gemini API
// -----------------------------
async function callGemini(prompt) {
  try {
    const response = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-pro:generateContent",
      {
        contents: [{ parts: [{ text: prompt }] }],
      },
      { headers: { "x-goog-api-key": process.env.GEMINI_API_KEY } }
    );

    return (
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No response from Gemini."
    );
  } catch (err) {
    console.error("Gemini API error:", err.response?.data || err.message);
    return "Gemini API error.";
  }
}

// -----------------------------
// Query Endpoint
// -----------------------------

app.get("/", async (req, res) => {
  res.json({ hello: "welcome! backend running." });
});

app.post("/query", async (req, res) => {
  try {
    let query = sanitizeInput(req.body.query || "");
    if (!query) return res.status(400).json({ error: "Invalid input." });

    const queryEmbedding = await embedText(query);
    const topDocs = await retrieveTopK(queryEmbedding, Number(process.env.TOP_K));
    const context = topDocs.join("\n");

    const prompt = `You are an AI assistant answering based on Shadow Fight knowledge base.
Context:\n${context}\n\nUser: ${query}\nAnswer clearly and in a formatted way.`;

    const responseText = await callGemini(prompt);
    res.json({ response: responseText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------
// Start Server
// -----------------------------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
