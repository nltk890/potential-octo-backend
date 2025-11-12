import os
import re
import faiss
import numpy as np
from pymongo import MongoClient
from sentence_transformers import SentenceTransformer
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx
import asyncio

# -----------------------------
# Load environment
# -----------------------------
load_dotenv()

MONGO_URI = os.getenv(MONGO_URI)
MONGO_DB = os.getenv(MONGO_DB)
MONGO_COLLECTION = os.getenv(MONGO_COLLECTION)
EMBEDDING_MODEL = os.getenv(EMBEDDING_MODEL)
TOP_K = int(os.getenv(TOP_K, 5))
GEMINI_API_KEY = os.getenv(GEMINI_API_KEY)
ALLOWED_ORIGIN = os.getenv(ALLOWED_ORIGIN)

if not all([MONGO_URI, MONGO_DB, MONGO_COLLECTION, EMBEDDING_MODEL, GEMINI_API_KEY, ALLOWED_ORIGIN])
    raise RuntimeError(Missing required environment variables)

# -----------------------------
# MongoDB Setup
# -----------------------------
client = MongoClient(MONGO_URI)
db = client[MONGO_DB]
collection = db[MONGO_COLLECTION]

# -----------------------------
# Embedding Model Setup
# -----------------------------
embedding_model = SentenceTransformer(EMBEDDING_MODEL)

# -----------------------------
# FAISS Index Setup
# -----------------------------
DIM = 384
faiss_index_path = embeddings.db
chunks = list(collection.find({}))

if os.path.exists(faiss_index_path)
    faiss_index = faiss.read_index(faiss_index_path)
    print(FAISS index loaded)
else    
    embeddings = np.array([chunk[embedding] for chunk in chunks], dtype=float32)
    faiss_index = faiss.IndexFlatIP(DIM)
    faiss.normalize_L2(embeddings)
    faiss_index.add(embeddings)
    faiss.write_index(faiss_index_path)
    print(f FAISS index created with {len(chunks)} vectors)

id_map = [chunk[_id] for chunk in chunks]

# -----------------------------
# FastAPI Setup
# -----------------------------
app = FastAPI(title=Shadow Fight RAG Agent)

# -----------------------------
# CORS (Only your frontend)
# -----------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN],
    allow_credentials=True,
    allow_methods=[POST],
    allow_headers=[Content-Type],
)

# -----------------------------
# Input Model (Plain Text Only)
# -----------------------------
class QueryRequest(BaseModel)
    query str

# -----------------------------
# XSS  Injection Guard
# -----------------------------
def sanitize_input(text str) - str
    # Remove all tags, scripts, code injection attempts
    text = re.sub(r., , text)
    text = re.sub(r[{}[]();], , text)
    text = re.sub(r[^ws.,!'-], , text)
    return text.strip()

# -----------------------------
# Retrieve top-k chunks
# -----------------------------
def retrieve_top_k(query str, top_k int = TOP_K)
    query_vec = embedding_model.encode(query)
    query_vec = np.array([query_vec], dtype=float32)
    faiss.normalize_L2(query_vec)
    D, I = faiss_index.search(query_vec, top_k)
    results = []
    for idx in I[0]
        doc = collection.find_one({_id id_map[idx]})
        if doc
            results.append(doc[text])
    return results

# -----------------------------
# Gemini API call
# -----------------------------
async def call_gemini(prompt str) - str
    url = httpsgenerativelanguage.googleapis.comv1betamodelsgemini-2.0-progenerateContent
    headers = {
        Content-Type applicationjson,
        x-goog-api-key GEMINI_API_KEY
    }
    payload = {contents [{parts [{text prompt}]}]}
    
    async with httpx.AsyncClient(timeout=60.0, verify=True) as client
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
    
    try
        return data[candidates][0][content][parts][0][text]
    except (KeyError, IndexError)
        return No valid response returned from Gemini API.

# -----------------------------
# Query Endpoint
# -----------------------------
@app.post(query)
async def query_endpoint(request QueryRequest)
    try
        # Sanitize
        query_text = sanitize_input(request.query)
        if not query_text
            raise HTTPException(status_code=400, detail=Query cannot be empty or contain invalid characters.)
        
        # Retrieve context
        context_chunks = retrieve_top_k(query_text)
        context_text = n.join(context_chunks)

        # Prepare prompt
        prompt = fAnswer user query based on this contextn{context_text}nnUser Question {query_text}
        
        # Call Gemini
        answer = await call_gemini(prompt)
        return {response answer}

    except httpx.HTTPStatusError as e
        raise HTTPException(status_code=e.response.status_code, detail=str(e))
    except Exception as e
        import traceback
        traceback.print_exc()

        raise HTTPException(status_code=500, detail=str(e))
