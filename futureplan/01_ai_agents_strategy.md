# AI Agents Strategy: Copilot & News Analyst

This document details the architecture for the two AI features of QuantVision: the Agentic Coder (for script generation) and the News Analyst (for sentiment scoring), designated for future development.

## 1. News Source API (Data Ingestion)
To provide the LLM with high-quality, relevant data for sentiment analysis, we need a reliable financial news feed. `yfinance` is insufficient for real-time news.

**Recommended Providers (For NSE/BSE Indian Stocks):**
1.  **Agentic Web Search (Function Calling):** Instead of manually scraping news, you provide the LLM with a Search API tool (e.g., **Tavily Search API**, **Google Custom Search**, or **DuckDuckGo**). When asked about a stock, the LLM dynamically executes a web search, reads the resulting headlines/snippets, and synthesizes the sentiment. This requires zero parsing logic on your end.
2.  **Financial RSS Feeds (The Dedicated Option):** If you want deep articles rather than search snippets, FastAPI can parse free RSS feeds from **The Economic Times** or **Moneycontrol**.
3.  **NewsData.io (API):** A global news API strictly filtered for `country=in`.
*   FastAPI extracts the headline and summary of the top 10 articles.
*   This text payload is sent to the LLM for analysis.

## 2. AI Model LLM Inference
The platform will utilize a Bring-Your-Own-Key (BYOK) model to keep the local application free to use.

**Integration:**
*   **Providers (APIs):**
    *   **Anthropic API (`claude-3.5-sonnet`):** Currently the industry leader for coding tasks. Highly recommended for the Agentic Coder.
    *   **Google Gemini API (`gemini-1.5-flash`):** Incredibly fast, cheap, and has a 1-million token context window. Perfect for instantly processing news sentiment and RAG stuffing.
    *   **OpenAI API (`gpt-4o-mini`):** A strong, cheap alternative for general tasks.
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
