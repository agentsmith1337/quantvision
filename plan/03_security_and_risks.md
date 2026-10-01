# Security, Risks & Vulnerabilities (Local Deployment)

Since QuantVision runs locally on the user's machine, the security profile changes dramatically from a hosted SaaS model. The risk is no longer protecting *your* servers, but protecting the *user's* machine and capital.

## 1. Malicious Script Execution (The Local Risk)
**The Risk:** Since users run code locally, Docker sandboxing on a server is irrelevant. However, if a user copies a "profitable trading script" from a malicious source online and runs it in your app, that script has access to their local files and could steal their Angel One API keys or install ransomware.
**Mitigation:**
*   **Virtual Environments:** Run user scripts in an isolated Python Virtual Environment (`venv`) to prevent them from messing with global system dependencies.
*   **Warning Prompts:** Prominently warn users in the UI never to run unverified code from the internet.
*   **Optional OS Restrictions:** Advanced OS-level user restrictions can be applied to the spawned subprocess, limiting file system access to only the QuantVision directory.

## 2. Local API Key Storage
**The Risk:** Storing Angel One API keys in plaintext in a local SQLite file means anyone with access to the computer (or malware) can steal them and execute trades.
**Mitigation:**
*   **OS Keychain:** Use Python libraries like `keyring` to store API keys securely in the operating system's native credential manager (Windows Credential Locker, macOS Keychain).
*   **User Password Encryption:** Alternatively, require the user to set a master app password. Use this password to encrypt the API keys in the SQLite database (using AES-256). The user must enter the password each time they launch the app to decrypt the keys in memory.

## 3. Financial Risks (The "Runaway Algo")
**The Risk:** Even running locally, a bug in the script could place hundreds of orders per second, draining funds or incurring massive fees.
**Mitigation:**
*   **Local Kill Switch:** A prominent UI button that immediately terminates the Python subprocess running the strategy and sends cancellation requests for all open orders.
*   **SDK Rate Limiting:** The Python SDK you provide to users for trading must have built-in, un-bypassable rate limits.

## 4. Software Dependencies & Packaging
**The Risk:** Requiring users to install Python, Node.js, and configure environments in the terminal is a huge barrier to entry and prone to setup errors.
**Mitigation:**
*   **Bundling:** Use tools like PyInstaller (for Python) or Tauri/Electron to bundle everything into a single, one-click executable installer (`.exe`) that requires zero technical setup from the user.
