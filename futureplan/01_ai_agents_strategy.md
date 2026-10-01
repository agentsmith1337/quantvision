# AI Agents Strategy: Copilot & News Analyst

This document details the architecture for the two AI features of QuantVision: the Agentic Coder (for script generation) and the News Analyst (for sentiment scoring), designated for future development.

## 1. News Source API (Data Ingestion)
To provide the LLM with high-quality, relevant data for sentiment analysis, we need a reliable financial news feed. `yfinance` is insufficient for real-time news.

**Recommended Providers:**
1.  **Finnhub:** Provides excellent real-time financial news, specifically tailored for stocks.
2.  **AlphaVantage (Market News & Sentiment):** Provides structured JSON news articles specifically tagged by ticker symbol, which is perfect for feeding into an LLM.

**Architecture:**
*   When a user opens the Trading Dashboard for `RELIANCE`, FastAPI calls the News API for recent articles tagged with that ticker.
*   FastAPI extracts the headline and summary of the top 10 articles.
*   This text payload is sent to the LLM for analysis.

## 2. AI Model LLM Inference
The platform will utilize a Bring-Your-Own-Key (BYOK) model to keep the local application free to use.

**Integration:**
*   **Providers:** Support for Google Gemini (via `google-genai` SDK) and OpenAI (via `openai` SDK).
*   **API Key Storage:** The user enters their chosen API key on the Setup Page, which is encrypted and stored in local SQLite.
*   **Execution:** 
    *   *News Analyst:* FastAPI sends the news payload to the LLM with a strict prompt forcing a **Structured JSON Output** (e.g., `{"sentiment": "BULLISH", "score": 0.85, "reasoning": "Positive earnings report..."}`). This allows Next.js to render a beautiful gauge chart rather than just a wall of text.
    *   *Agentic Coder:* Operates as a chat interface in the Backtesting Studio, maintaining conversation history to iteratively debug or build Python trading scripts.

## 3. RAG Strategy for Angel One SDK
The biggest challenge for the Agentic Coder is preventing it from hallucinating generic Python code and forcing it to use our specific Angel One SDK wrapper.

**The Solution: Context Stuffing (Zero-Setup RAG)**
Because modern LLMs (like Gemini 1.5 Pro or GPT-4o) have massive context windows (128k to 2 Million tokens), we **do not need a complex Vector Database** for RAG. 

1.  **The SDK Manual:** We will maintain a single markdown file in the backend codebase (e.g., `sdk_reference.md`) that contains the complete documentation, available technical indicators, and code examples for our QuantVision Python SDK.
2.  **Prompt Injection:** Every time the user asks the Copilot to write or debug a script, FastAPI silently prepends the *entire* `sdk_reference.md` file into the LLM's "System Prompt".
3.  **The Result:** The LLM instantly becomes a world-class expert on our specific SDK because the entire instruction manual is loaded into its working memory for every single question.

**Example System Prompt:**
> "You are an expert algorithmic trading engineer. Write Python code using ONLY the methods defined in the provided QuantVision SDK documentation below. Do not use generic requests or standard Angel One libraries, only use the injected `api` object.
> 
> --- SDK DOCUMENTATION ---
> [Contents of sdk_reference.md]
> -------------------------"
