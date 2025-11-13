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

if (!MONGO_URI || !GEMINI_API_KEY)
  throw new Error("Missing required environment variables!");

// -----------------------------
// Express app setup
// -----------------------------
const app = express();
app.use(express.json());
app.use(
  cors({
    origin: ALLOWED_ORIGIN,
    methods: ["POST", "GET"],
    credentials: true,
  })
);

// -----------------------------
// MongoDB connection
// -----------------------------
const client = new MongoClient(MONGO_URI);
let collection;

async function connectDB() {
  await client.connect();
  const db = client.db(MONGO_DB);
  collection = db.collection(MONGO_COLLECTION);
  console.log("Connected to MongoDB Atlas");
}
await connectDB();

// -----------------------------
// Gemini API setup
// -----------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
const chatModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// -----------------------------
// Utility: sanitize user input
// -----------------------------
function sanitizeInput(text) {
  return text
    .replace(/<[^>]*>?/gm, "")
    .replace(/[{}[\]();<>]/g, "")
    .replace(/[^a-zA-Z0-9\s.,!?'-]/g, "")
    .trim();
}

// -----------------------------
// API endpoint
// -----------------------------
app.get("/", (req, res) => {
  res.send("Shadows Fate AI working on this!");
});

app.post("/query", async (req, res) => {
  try {
    const userQuery = sanitizeInput(req.body.query || "");
    if (!userQuery) return res.status(400).json({ error: "Empty query." });

    // Embed query using Gemini
    const { embedding } = await embeddingModel.embedContent(userQuery);

    // Perform vector search
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
    if (!docs.length)
      return res.status(404).json({ response: "No relevant information found." });

    // Combine retrieved chunks
    const context = docs.map((d, i) => `(${i + 1}) ${d.text}`).join("\n\n");

    // Ask Gemini
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
You are a lore and gameplay expert of the Shadow Fight series.
Use ONLY the following context to answer the user's question accurately.

Context:
${context}

User question:
"${userQuery}"

Your answer must be:
- Well formatted in Markdown (with bold headings, bullet points, and paragraphs)
- Informative but concise
- Never hallucinate or invent facts
`;

    const result = await chat.sendMessage(ragPrompt);
    const llmResponse = result.response.text();

    res.json({ response: llmResponse });

  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(500).json({ error: "An error occurred while processing the query." });
  }
});

// -----------------------------
// Server startup
// -----------------------------
const port = PORT || 8000;

app.listen(port, "0.0.0.0", () => console.log(`Server running on port ${port}`));
