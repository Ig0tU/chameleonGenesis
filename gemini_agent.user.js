// ==UserScript==
// @name         Gemini Web Agent - Unlocked v5.3 (Refactored)
// @namespace    http://tampermonkey.net/
// @version      2025.09.03.4
// @description  A state-of-the-art agentic framework powered by Google Gemini. It observes, reasons, and acts to execute complex web tasks from natural language commands with enhanced robustness, UI, error handling, and dynamic element targeting.
// @author       GodCodeRX (Gemini/User Merge) & Genasys
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      generativelanguage.googleapis.com
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/lucide@latest/dist/umd/lucide.min.js
// @require      https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js
// ==/UserScript==

(function() {
    'use strict';

    // Ensure lodash and lucide are available
    if (typeof _ === 'undefined' || typeof lucide === 'undefined') {
        console.error("Gemini Web Agent: lodash or lucide not loaded. Please check @require directives.");
        return;
    }

    /**
     * @typedef {object} AgentConfig
     * @property {string} geminiApiKey - Google Gemini API Key.
     * @property {number} postActionDelay - Delay after actions for UI to settle (ms).
     * @property {{min: number, max: number}} typingDelay - Range for simulating natural typing (ms).
     * @property {number} maxHistory - History depth for context.
     * @property {number} elementScanInterval - Periodic DOM scan interval (ms).
     * @property {{top: number, left: number}} uiPosition - UI initial position.
     * @property {boolean} uiMinimized - UI initial state (minimized/expanded).
     * @property {number} maxRetries - Max retries for API calls and element interactions.
     * @property {number} retryDelay - Delay between retries (ms).
     * @property {number} maxExecutionTime - Maximum time an agent task can run before being stopped (ms).
     * @property {Object.<string, boolean>} moduleEnabled - Configuration to enable/disable specific agent modules.
     */

    /**
     * Configuration for the Gemini Web Agent.
     * This object can be extended with more settings as needed.
     * @type {AgentConfig}
     */
    const CONFIG = {
        geminiApiKey: '', // This will be loaded from storage
        postActionDelay: 750,
        typingDelay: { min: 15, max: 60 },
        maxHistory: 15,
        elementScanInterval: 1500, // Slightly increased for less aggressive scanning
        uiPosition: { top: 20, left: 20 }, // This will be loaded from storage
        uiMinimized: false, // This will be loaded from storage
        maxRetries: 3,
        retryDelay: 500,
        maxExecutionTime: 5 * 60 * 1000, // 5 minutes
        moduleEnabled: { // Configuration to enable/disable specific agent modules
            domObserver: true,
            geminiCore: true,
            actionExecutor: true
        }
    };

    /**
     * @typedef {object} UserProfile
     * @property {string} firstName
     * @property {string} lastName
     * @property {string} baseEmail
     * @property {string} baseUsername
     * @property {string} phone
     * @property {{street: string, city: string, state: string, zip: string, country: string}} address
     */

    /**
     * Base profile data for generating site-specific profiles.
     * @type {UserProfile}
     */
    const BASE_PROFILE = {
        firstName: 'Alex',
        lastName: 'Smith',
        baseEmail: 'alex.smith.dev.91@example.com',
        baseUsername: 'alexsmith91',
        phone: '555-867-5309',
        address: { street: '42 Wallaby Way', city: 'Sydney', state: 'NSW', zip: '2000', country: 'Australia' },
    };

    /**
     * Manages persistent storage using GM_setValue and GM_getValue.
     */
    class StorageManager {
        /**
         * Retrieves a value from storage.
         * @param {string} key - The key to retrieve.
         * @param {*} defaultValue - The value to return if the key is not found.
         * @returns {*} The retrieved value or the default value.
         */
        static getValue(key, defaultValue) {
            try {
                return GM_getValue(key, defaultValue);
            } catch (e) {
                console.error(`StorageManager: Failed to get value for key "${key}":`, e);
                return defaultValue;
            }
        }

        /**
         * Sets a value in storage.
         * @param {string} key - The key to set.
         * @param {*} value - The value to store.
         */
        static setValue(key, value) {
            try {
                GM_setValue(key, value);
            } catch (e) {
                console.error(`StorageManager: Failed to set value for key "${key}":`, e);
            }
        }
    }

    // Load initial CONFIG values from storage
    CONFIG.geminiApiKey = StorageManager.getValue('geminiApiKey', CONFIG.geminiApiKey);
    CONFIG.uiPosition = StorageManager.getValue('agentUIPosition', CONFIG.uiPosition);
    CONFIG.uiMinimized = StorageManager.getValue('agentUIMinimized', CONFIG.uiMinimized);

    /**
     * Utility for generating site keys from URLs.
     */
    class SiteKeyGenerator {
        /**
         * Generates a simple site key from a hostname.
         * @param {string} hostname - The hostname of the site.
         * @returns {string} A normalized site key (e.g., 'google.com' -> 'google').
         */
        static generateKey(hostname) {
            try {
                // Remove 'www.' and get the effective top-level domain part
                const parts = hostname.replace(/^www\./, '').split('.');
                if (parts.length > 2 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length <= 3) {
                    // Likely a co.uk or similar, keep more parts
                    return parts[parts.length - 3];
                }
                return parts[0]; // Just use the first part (e.g., 'google' from 'google.com')
            } catch (e) {
                console.warn("SiteKeyGenerator: Could not parse hostname, using full hostname as fallback.", e);
                return hostname;
            }
        }
    }

    /**
     * Manages session state, action history, and securely handles temporary credentials.
     * Enhances profile generation and credential management with caching.
     */
    class MemoryManager {
        /**
         * @param {UserProfile} baseProfile - The base user profile.
         */
        constructor(baseProfile) {
            /** @type {UserProfile} */
            this.baseProfile = _.cloneDeep(baseProfile);
            /** @type {Object.<string, string>} */
            this.sessionCredentials = {}; // Stores temporary credentials like passwords
            /** @type {Array<object>} */
            this.actionHistory = this._loadActionHistory(); // Stores { action, observation } pairs
            /** @type {Object.<string, UserProfile>} */
            this.siteProfiles = {}; // Cache for generated site-specific profiles
        }

        /**
         * Generates or retrieves a site-specific profile, merging base data with session credentials.
         * Utilizes a more flexible templating system for email and username generation.
         * @param {string} siteKey - Identifier for the website (e.g., hostname).
         * @param {object} [overrides={}] - Additional profile data overrides.
         * @returns {UserProfile} The generated site-specific profile.
         */
        getProfileForSite(siteKey, overrides = {}) {
            if (this.siteProfiles[siteKey]) {
                return _.cloneDeep(this.siteProfiles[siteKey]); // Return cached profile if available
            }

            const profile = _.cloneDeep(this.baseProfile);
            const emailParts = this.baseProfile.baseEmail.split('@');

            // Flexible templating for email and username
            // Example patterns: {baseEmailPart1}+{siteKey}@{baseEmailPart2}, {baseUsername}_{siteKey}
            profile.email = `${emailParts[0]}+${siteKey}@${emailParts[1]}`;
            profile.username = `${this.baseProfile.baseUsername}_${siteKey}`;

            // Deep merge address and other overrides
            profile.address = _.merge(_.cloneDeep(profile.address), overrides.address);
            _.unset(overrides, 'address'); // Prevent merging address twice
            _.assign(profile, overrides); // Apply remaining overrides

            // Integrate session credentials, prioritizing them
            if (this.sessionCredentials.password) profile.password = this.sessionCredentials.password;
            if (this.sessionCredentials.username) profile.username = this.sessionCredentials.username;

            this.siteProfiles[siteKey] = _.cloneDeep(profile); // Cache the generated profile
            return profile;
        }

        /**
         * Sets or updates a session credential.
         * @param {string} key - Credential type (e.g., 'password').
         * @param {string} value - Credential value.
         */
        setCredential(key, value) {
            this.sessionCredentials[key] = value;
            // Invalidate cached profiles if critical credentials change
            if (key === 'password' || key === 'username') {
                this.siteProfiles = {};
            }
        }

        /**
         * Adds an action and its observation to the history, maintaining max history length.
         * Persists action history to storage.
         * @param {object} action - The action performed by the agent.
         * @param {string} observation - The result or feedback from the action.
         */
        addHistory(action, observation) {
            this.actionHistory.push({ action, observation, timestamp: Date.now() });
            if (this.actionHistory.length > CONFIG.maxHistory) {
                this.actionHistory.shift(); // Remove oldest entry if history exceeds max length
            }
            this._saveActionHistory();
        }

        /**
         * Returns a deep copy of the current action history.
         * @returns {Array<object>} The action history.
         */
        getHistory() {
            return _.cloneDeep(this.actionHistory);
        }

        /**
         * Clears the action history, any cached site profiles, and persistent storage.
         */
        clearHistory() {
            this.actionHistory = [];
            this.sessionCredentials = {}; // Also clear session credentials
            this.siteProfiles = {};
            this._saveActionHistory(); // Clear persistent history
        }

        /**
         * Loads action history from persistent storage.
         * @private
         * @returns {Array<object>} Loaded action history.
         */
        _loadActionHistory() {
            const history = StorageManager.getValue('gwaActionHistory', []);
            // Simple validation to prevent storing excessively large history
            if (history.length > CONFIG.maxHistory * 2) { // Allow some buffer, then trim
                return history.slice(-CONFIG.maxHistory);
            }
            return history;
        }

        /**
         * Saves action history to persistent storage.
         * @private
         */
        _saveActionHistory() {
            StorageManager.setValue('gwaActionHistory', this.actionHistory);
        }
    }

    /**
     * Scans the DOM to create a simplified, machine-readable summary of the page state for the AI.
     * Enhances accessibility, element identification, and uses MutationObserver for efficiency.
     */
    class DOMObserver {
        /**
         * @param {GeminiWebAgent} agent - The main agent instance for logging.
         */
        constructor(agent) {
            this.agent = agent;
            /** @type {Map<string, Element>} */
            this.elementMap = new Map(); // Maps internal IDs to DOM elements
            /** @type {MutationObserver|null} */
            this.observer = null; // MutationObserver instance
            /** @type {number|null} */
            this.scanTimeout = null; // For periodic rescans
            /** @type {number|null} */
            this.mutationDebounceTimer = null; // Debounce timer for MutationObserver
            this.lastObservedState = null; // Store last observed state to prevent redundant scans
        }

        /**
         * Checks if a DOM element is visible and interactable within the viewport.
         * @param {Element} el - The DOM element to check.
         * @returns {boolean} True if visible and interactable, false otherwise.
         */
        isVisible(el) {
            if (!el || el.offsetParent === null) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);

            // Check dimensions, display, visibility, and opacity
            if (rect.width === 0 && rect.height === 0) return false;
            if (style.visibility === 'hidden' || style.display === 'none') return false;
            if (parseFloat(style.opacity) < 0.1) return false; // Consider very low opacity as not visible

            // Check if element is within viewport
            const inViewport = rect.top < (window.innerHeight || document.documentElement.clientHeight) &&
                               rect.left < (window.innerWidth || document.documentElement.clientWidth) &&
                               rect.bottom > 0 &&
                               rect.right > 0;

            if (!inViewport) return false;

            // More robust check: check if element is actually covered by another element
            // This can be performance intensive, so use with caution or as a fallback
            try {
                 const elAtPoint = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                 // Check if the element at the center point is the element itself or a child
                 return el.contains(elAtPoint);
            } catch (e) {
                // Ignore errors, e.g., if element is removed from DOM while checking.
                // Returning false is safer than true, as it prevents acting on an element
                // where visibility could not be reliably determined.
                return false;
            }
        }

        /**
         * Retrieves an accessible name for an element, prioritizing ARIA attributes and fallbacks.
         * @param {Element} el - The DOM element.
         * @returns {string} The accessible name.
         */
        getAccessibleName(el) {
            let name = el.getAttribute('aria-label');
            if (!name && el.hasAttribute('aria-labelledby')) {
                const labelledby = document.getElementById(el.getAttribute('aria-labelledby'));
                if (labelledby) name = labelledby.textContent;
            }
            name = name || el.getAttribute('alt') || el.getAttribute('title') || el.placeholder || el.textContent;

            // For input fields, consider associated <label>
            if (!name && el.id && el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
                const label = document.querySelector(`label[for="${el.id}"]`);
                if (label) name = label.textContent;
            }

            if (name) return _.truncate(name.trim().replace(/\s+/g, ' '), { length: 100, omission: '...' });

            // Fallback to ID or class name
            if (el.id) return `#${el.id}`;
            if (el.className) return `.${el.className.split(/\s+/)[0]}`;
            return el.tagName.toLowerCase();
        }

        /**
         * Scores an element based on its potential relevance for interaction.
         * Higher score means more relevant.
         * @param {Element} el - The DOM element.
         * @returns {number} The score.
         */
        scoreElement(el) {
            let score = 0;
            const tagName = el.tagName.toLowerCase();
            const type = el.getAttribute('type');

            // Prioritize interactive elements
            if (['input', 'textarea', 'select', 'button', 'a'].includes(tagName)) score += 10;
            if (el.hasAttribute('onclick') || el.hasAttribute('href') || el.hasAttribute('tabindex')) score += 5;
            if (el.isContentEditable) score += 10;

            // Prioritize elements with ARIA roles or specific types
            if (el.hasAttribute('role')) {
                const role = el.getAttribute('role');
                if (['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch'].includes(role)) score += 8;
            }
            if (tagName === 'input' && ['text', 'email', 'password', 'search', 'tel', 'url'].includes(type)) score += 7;
            if (tagName === 'input' && ['submit', 'button', 'reset'].includes(type)) score += 9;

            // Prioritize elements with descriptive names/labels
            if (el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder || (el.id && el.id.length > 5)) score += 5;
            if (this.getAccessibleName(el) && this.getAccessibleName(el).length > 5) score += 3;

            // Demote hidden/disabled elements (already handled by isVisible, but good for redundancy)
            if (el.disabled || el.readOnly) score -= 100; // Effectively remove

            return score;
        }

        /**
         * Performs a comprehensive scan of the DOM for interactive elements.
         * @returns {object} Page state including URL, title, and interactive elements.
         */
        observe() {
            if (!CONFIG.moduleEnabled.domObserver) {
                this.agent.log('DOM Observer module is disabled.', 'warn');
                return { url: window.location.href, title: document.title, elements: [] };
            }

            this.agent.log('Observer: Scanning page for interactive elements...', 'system');
            this.elementMap.clear();
            const interactiveElements = [];
            let elementIdCounter = 0;

            // Broad selector for common interactive elements and ARIA roles
            const selector = 'a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], label, [contenteditable="true"]';

            const elementsToScan = Array.from(document.querySelectorAll(selector));

            // Sort elements by score to prioritize relevant ones for LLM context
            elementsToScan.sort((a, b) => this.scoreElement(b) - this.scoreElement(a));

            for (const el of elementsToScan) {
                if (this.isVisible(el)) {
                    const id = `el-${elementIdCounter++}`;
                    this.elementMap.set(id, el);

                    const elementType = el.tagName.toLowerCase();
                    let typeAttribute = el.type || null;

                    // Refine element type for clarity
                    if (elementType === 'a') typeAttribute = 'link';
                    else if (elementType === 'button') typeAttribute = 'button';
                    else if (elementType === 'input') typeAttribute = el.type || 'text';
                    else if (elementType === 'textarea') typeAttribute = 'textarea';
                    else if (elementType === 'select') typeAttribute = 'select';
                    else if (el.hasAttribute('role')) typeAttribute = el.getAttribute('role');
                    else if (el.isContentEditable) typeAttribute = 'editable';

                    interactiveElements.push({
                        id: id,
                        tag: elementType,
                        name: this.getAccessibleName(el),
                        type: typeAttribute,
                        value: el.value || el.textContent || null,
                        placeholder: el.placeholder || null,
                        ariaLabel: el.getAttribute('aria-label') || null,
                        role: el.getAttribute('role') || null,
                        // Add disabled/readonly status for more context
                        disabled: el.disabled || el.readOnly || false
                    });
                }
            }

            const currentState = {
                url: window.location.href,
                title: document.title,
                elements: interactiveElements
            };

            // Only update and log if the state has significantly changed
            if (!_.isEqual(this.lastObservedState, currentState)) {
                this.agent.log(`Observer: Found ${interactiveElements.length} interactive elements.`, 'info');
                this.lastObservedState = _.cloneDeep(currentState);
            } else {
                this.agent.log('Observer: Page state unchanged, skipping re-scan.', 'debug');
            }

            return currentState;
        }

        /**
         * Retrieves a DOM element from the internal map using its ID.
         * @param {string} id - The internal ID of the element.
         * @returns {Element|null} The DOM element or null if not found.
         */
        getElement(id) {
            return this.elementMap.get(id) || null;
        }

        /**
         * Starts observing the DOM using MutationObserver and periodic rescans.
         * Implements debouncing for MutationObserver callbacks.
         */
        start() {
            if (!CONFIG.moduleEnabled.domObserver) {
                this.agent.log('DOM Observer module is disabled, not starting.', 'warn');
                return;
            }

            this.agent.log('Observer: Starting DOM observation.', 'system');
            this.observe(); // Initial scan on start

            // Debounce MutationObserver callbacks
            const debouncedObserve = () => {
                if (this.mutationDebounceTimer) clearTimeout(this.mutationDebounceTimer);
                this.mutationDebounceTimer = setTimeout(() => {
                    this.agent.log('Observer: DOM changed, rescanning...', 'debug');
                    this.observe();
                }, 200); // Debounce for 200ms
            };

            this.observer = new MutationObserver(debouncedObserve);
            this.observer.observe(document.body, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['class', 'style', 'id', 'aria-label', 'placeholder', 'value', 'textContent', 'innerText', 'disabled', 'readonly', 'checked', 'selected']
            });

            // Periodic scan for changes not caught by MutationObserver (e.g., elements becoming visible due to scroll)
            this.scanTimeout = setInterval(() => {
                // Use requestIdleCallback if available for less intrusive periodic scans
                if (typeof requestIdleCallback === 'function') {
                    requestIdleCallback(() => {
                        this.agent.log('Observer: Performing periodic scan (idle callback)...', 'debug');
                        this.observe();
                    }, { timeout: 1000 }); // Give it 1 second to run during idle
                } else {
                    this.agent.log('Observer: Performing periodic scan (fallback)...', 'debug');
                    this.observe();
                }
            }, CONFIG.elementScanInterval);
        }

        /** Stops the DOM observer and any pending scans. */
        stop() {
            if (this.observer) { this.observer.disconnect(); this.observer = null; }
            if (this.scanTimeout) { clearInterval(this.scanTimeout); this.scanTimeout = null; }
            if (this.mutationDebounceTimer) { clearTimeout(this.mutationDebounceTimer); this.mutationDebounceTimer = null; }
            this.agent.log('Observer: Stopped DOM observation.', 'system');
        }
    }

    /**
     * Manages communication with the Google Gemini API for decision-making.
     * Includes robust prompt engineering, error handling, and retry logic.
     */
    class GeminiCore {
        /**
         * @param {GeminiWebAgent} agent - The main agent instance for logging and UI updates.
         */
        constructor(agent) {
            this.agent = agent;
            this.API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${CONFIG.geminiApiKey}`;
            this.generationConfig = {
                temperature: 0.7,
                topP: 0.9,
                topK: 40,
                maxOutputTokens: 1024,
            };
            this.apiCallQueue = [];
            this.isProcessingQueue = false;
        }

        /**
         * Updates the API key and endpoint.
         * @param {string} newKey - The new Gemini API key.
         */
        updateApiKey(newKey) {
            this.API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${newKey}`;
        }

        /**
         * Constructs the detailed prompt for the Gemini API based on objective, page state, and history.
         * Dynamically adjusts prompt content based on inferred objective type.
         * @param {string} objective - The user's goal.
         * @param {object} pageState - The current state of the webpage.
         * @param {Array<object>} history - The history of agent actions and observations.
         * @returns {string} The formatted prompt for Gemini.
         */
        buildPrompt(objective, pageState, history) {
            const historyString = history.map(h => `User Action: ${JSON.stringify(h.action)}\nAgent Observation: ${h.observation}`).join('\n\n');

            let objectiveTypeHint = '';
            const lowerObjective = objective.toLowerCase();
            if (lowerObjective.includes('login') || lowerObjective.includes('sign in') || lowerObjective.includes('log in')) {
                objectiveTypeHint = 'The objective seems to be a login/authentication task. Focus on finding username, password, and login buttons.';
            } else if (lowerObjective.includes('form') || lowerObjective.includes('fill out')) {
                objectiveTypeHint = 'The objective involves filling out a form. Identify relevant input fields and submission buttons.';
            } else if (lowerObjective.includes('navigate to') || lowerObjective.includes('go to')) {
                objectiveTypeHint = 'The objective is a navigation task. Use the NAVIGATE action directly if a URL is given, or find relevant links.';
            } else if (lowerObjective.includes('buy') || lowerObjective.includes('purchase')) {
                objectiveTypeHint = 'The objective is a purchasing task. Focus on product selection, adding to cart, and checkout processes.';
            }

            const systemPrompt = `You are an advanced AI web automation agent. Your primary goal is to fulfill the user's objective by interacting with the provided webpage.
You have access to a set of predefined actions. Analyze the current page state and the history to determine the most effective next action.

**Page State:**
- URL: ${pageState.url}
- Title: ${pageState.title}
- Interactive Elements: ${JSON.stringify(pageState.elements, null, 2)}

**Available Actions:**
- TYPE(elementId, value, isCredential = false, inputType = 'text'): Type text into an input field. 'value' can be literal text or a profile key (e.g., 'email', 'password'). Set isCredential to true for sensitive data. inputType is a hint (e.g., 'password', 'text', 'number').
- CLICK(elementId): Click on a clickable element (links, buttons, etc.) identified by elementId.
- SELECT(elementId, optionText): Select an option from a dropdown (SELECT element) by its visible text.
- NAVIGATE(url): Navigate the browser to a new URL. Use this for direct navigation tasks or when the next step requires a different page.
- VERIFY_TEXT(text): Assert that a specific piece of text exists anywhere on the current page. Returns a boolean observation.
- THINK(thought): Articulate your reasoning process, intermediate steps, or plans. This is crucial for complex tasks and debugging. Use this to explain *why* you chose an action.
- FINISH(summary): Conclude the task. Provide a concise summary of the outcome, whether successful or not.

**Important Guidelines:**
1.  **Prioritize User Objective:** Always focus on achieving the user's stated objective.
2.  **Use Element IDs:** Refer to elements exclusively by their provided IDs (e.g., "el-5").
3.  **Contextual Typing:** If typing a value like 'email' or 'password', use the profile keys. The agent will resolve these to actual values. Use 'isCredential: true' for sensitive data. Specify inputType if known (e.g., 'password').
4.  **Error Handling:** If an element is not found or an action fails, use THINK to explain the issue and choose an alternative action or FINISH if the task is blocked.
5.  **Page State Analysis:** Carefully examine the 'elements' array in the page state. Look for descriptive names, types, and values to identify the correct element. Pay attention to 'disabled' property.
6.  **Sequential Actions:** Perform one atomic action at a time, unless the objective explicitly requires a sequence that can be represented by multiple THINK actions followed by a final action.
7.  **Respond with JSON Only:** Your entire response must be a single, valid JSON object representing the chosen action. Do not include any explanatory text, markdown, or comments outside the JSON structure.

**Example Response Format:**
\`\`\`json
{"action": "TYPE", "elementId": "el-12", "value": "email", "isCredential": false, "inputType": "email"}
\`\`\`
\`\`\`json
{"action": "THINK", "thought": "I need to find the login button. It's likely labeled 'Sign In' or similar."}
\`\`\`
\`\`\`json
{"action": "FINISH", "summary": "Successfully logged in."}
\`\`\`

Now, analyze the following:`;

            const userPrompt = `
Objective: "${objective}"
${objectiveTypeHint}

Current Page State:
${JSON.stringify(pageState, null, 2)}

Action History:
${historyString || 'No actions taken yet.'}

Provide the single best next action in JSON format.`;

            return systemPrompt + userPrompt;
        }

        /**
         * Sends the prompt to Gemini API, handles retries, and parses the response.
         * Uses a queuing mechanism to manage concurrent API calls.
         * @param {string} objective - The user's objective.
         * @param {object} pageState - Current page state.
         * @param {Array<object>} history - Action history.
         * @returns {Promise<object>} The next action JSON.
         */
        async decideNextAction(objective, pageState, history) {
            if (!CONFIG.moduleEnabled.geminiCore) {
                this.agent.log('Gemini Core module is disabled.', 'warn');
                return { action: 'FINISH', summary: 'Gemini Core module is disabled.' };
            }

            return new Promise((resolve, reject) => {
                this.apiCallQueue.push({ objective, pageState, history, resolve, reject });
                this._processQueue();
            });
        }

        /**
         * Processes the API call queue, ensuring only one call is active at a time.
         * @private
         */
        async _processQueue() {
            if (this.isProcessingQueue || this.apiCallQueue.length === 0) {
                return;
            }

            this.isProcessingQueue = true;
            const { objective, pageState, history, resolve, reject } = this.apiCallQueue.shift();

            this.agent.log('Reasoning Core: Asking Gemini for next action...', 'system');
            this.agent.ui.updateAgentStatus('reasoning', 'Thinking...');

            if (!CONFIG.geminiApiKey) {
                this.agent.log('Gemini API Key is missing. Please set it in the script.', 'error');
                this.isProcessingQueue = false;
                reject(new Error('Gemini API Key not configured.'));
                this._processQueue(); // Process next in queue
                return;
            }

            const prompt = this.buildPrompt(objective, pageState, history);

            for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
                try {
                    const response = await new Promise((res, rej) => {
                        GM_xmlhttpRequest({
                            method: 'POST',
                            url: this.API_ENDPOINT,
                            headers: { 'Content-Type': 'application/json' },
                            data: JSON.stringify({
                                contents: [{ parts: [{ text: prompt }] }],
                                generationConfig: this.generationConfig,
                            }),
                            onload: res,
                            onerror: rej
                        });
                    });

                    const data = JSON.parse(response.responseText);

                    if (data.error) {
                        throw new Error(`Gemini API Error: ${data.error.message} (Code: ${data.error.code})`);
                    }
                    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0].text) {
                        throw new Error('Invalid response format from Gemini API: Missing candidate content.');
                    }

                    const text = data.candidates[0].content.parts[0].text;
                    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/i) || text.match(/```([\s\S]*?)```/i) || text.match(/({[\s\S]*})/i);
                    let actionJson = null;
                    if (jsonMatch && jsonMatch[1]) {
                        actionJson = JSON.parse(jsonMatch[1]);
                    } else {
                        actionJson = JSON.parse(text);
                    }

                    // Structured output validation schema
                    const isValidAction = (action) => {
                        if (typeof action !== 'object' || action === null || typeof action.action !== 'string') return false;
                        switch (action.action) {
                            case 'TYPE':
                                return typeof action.elementId === 'string' && (typeof action.value === 'string' || typeof action.value === 'number' || typeof action.value === 'boolean') && typeof action.isCredential === 'boolean';
                            case 'CLICK':
                                return typeof action.elementId === 'string';
                            case 'SELECT':
                                return typeof action.elementId === 'string' && typeof action.optionText === 'string';
                            case 'NAVIGATE':
                                return typeof action.url === 'string' && (action.url.startsWith('http://') || action.url.startsWith('https://'));
                            case 'VERIFY_TEXT':
                                return typeof action.text === 'string';
                            case 'THINK':
                                return typeof action.thought === 'string';
                            case 'FINISH':
                                return typeof action.summary === 'string';
                            default:
                                return false;
                        }
                    };

                    if (!isValidAction(actionJson)) {
                        throw new Error(`Malformed action JSON received. Does not conform to schema: ${JSON.stringify(actionJson)}`);
                    }

                    this.agent.log(`Gemini decided: ${actionJson.action}`, 'info');
                    this.agent.ui.updateAgentStatus('reasoning', `Decided: ${actionJson.action}`);
                    this.isProcessingQueue = false;
                    resolve(actionJson);
                    this._processQueue();
                    return;

                } catch (error) {
                    this.agent.log(`Error in Gemini API call (Attempt ${attempt}/${CONFIG.maxRetries}): ${error.message}`, 'error');
                    if (attempt === CONFIG.maxRetries) {
                        this.agent.ui.updateAgentStatus('reasoning', 'Error!');
                        this.isProcessingQueue = false;
                        reject(new Error(`Failed to get decision from Gemini after ${CONFIG.maxRetries} retries: ${error.message}`));
                        this._processQueue();
                        return;
                    }
                    await new Promise(r => setTimeout(r, CONFIG.retryDelay));
                }
            }
        }
    }

    /**
     * Executes the atomic actions decided by the GeminiCore.
     * Implements retry logic for transient failures.
     */
    class ActionExecutor {
        /**
         * @param {GeminiWebAgent} agent - The main agent instance for logging and DOM interaction.
         */
        constructor(agent) {
            this.agent = agent;
        }

        /**
         * Executes a given action step, with retry logic.
         * @param {object} step - The action step object { action, ...params }.
         * @returns {Promise<string>} A promise resolving with the observation string.
         */
        async execute(step) {
            if (!CONFIG.moduleEnabled.actionExecutor) {
                this.agent.log('Action Executor module is disabled.', 'warn');
                return `Action ${step.action} skipped: Executor module disabled.`;
            }

            this.agent.log(`Executor: Performing [${step.action}]...`, 'info');
            this.agent.ui.updateAgentStatus('executor', `Executing ${step.action}`);

            for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
                try {
                    // Special handling for navigation, as it stops the current script context.
                    if (step.action === 'NAVIGATE') {
                        // The navigate function handles history and redirects. It returns a promise
                        // that never resolves to halt this execution chain.
                        return await this.navigate(step);
                    }

                    let observation = '';
                    switch(step.action) {
                        case 'TYPE': observation = await this.type(step); break;
                        case 'CLICK': observation = await this.click(step); break;
                        case 'SELECT': observation = await this.select(step); break;
                        // NAVIGATE is handled above.
                        case 'VERIFY_TEXT': observation = this.verifyText(step); break;
                        case 'THINK': observation = this.think(step); break;
                        case 'FINISH': observation = this.finish(step); break;
                        default: throw new Error(`Unknown action '${step.action}'.`);
                    }

                    // Handle dynamic page changes: re-scan DOM after certain actions
                    if (['CLICK', 'TYPE', 'SELECT'].includes(step.action)) { // Removed NAVIGATE from here
                        // Small delay to allow page to render changes before re-scanning
                        await new Promise(r => setTimeout(r, CONFIG.postActionDelay));
                        this.agent.domObserver.observe(); // Force a re-scan
                    }

                    return observation;

                } catch (error) {
                    const errMsg = `Executor error during '${step.action}' (Attempt ${attempt}/${CONFIG.maxRetries}): ${error.message}`;
                    this.agent.log(errMsg, 'error');
                    if (attempt === CONFIG.maxRetries) {
                        this.agent.ui.updateAgentStatus('executor', 'Error!');
                        throw new Error(`Failed to execute action ${step.action} after ${CONFIG.maxRetries} retries: ${error.message}`);
                    }
                    await new Promise(r => setTimeout(r, CONFIG.retryDelay));
                }
            }
            throw new Error(`Unknown error during action execution.`);
        }

        /**
         * Types text into an element, simulating human typing and handling credentials.
         * Supports clearing field before typing and different input types.
         * @param {object} params - Action parameters.
         * @param {string} params.elementId - ID of the element.
         * @param {string} params.value - Value to type (literal or profile key).
         * @param {boolean} [params.isCredential=false] - True if value is sensitive.
         * @param {string} [params.inputType='text'] - Hint for input type (e.g., 'password', 'number').
         */
        async type({ elementId, value, isCredential = false, inputType = 'text' }) {
            const el = this.agent.domObserver.getElement(elementId);
            if (!el) throw new Error(`Element with ID ${elementId} not found.`);
            if (el.disabled || el.readOnly) throw new Error(`Element ${elementId} is disabled or read-only.`);
            if (!['input', 'textarea'].includes(el.tagName.toLowerCase()) && !el.isContentEditable) {
                throw new Error(`Element ${elementId} is not a valid input field.`);
            }

            let textToType = value;
            if (isCredential) {
                const credential = await this.agent.ui.promptForCredential(inputType);
                if (credential === null) throw new Error('User cancelled credential input.');
                textToType = credential;
                this.agent.memory.setCredential(value, textToType);
            } else {
                const siteKey = SiteKeyGenerator.generateKey(window.location.hostname);
                const siteProfile = this.agent.memory.getProfileForSite(siteKey);
                textToType = siteProfile[value] !== undefined ? String(siteProfile[value]) : value;
            }

            el.focus();
            if (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea') {
                el.value = ''; // Clear existing value
            } else if (el.isContentEditable) {
                el.innerHTML = ''; // Clear content for contenteditable
            }

            for (const char of String(textToType)) {
                if (el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea') {
                    el.value += char;
                } else if (el.isContentEditable) {
                    el.innerHTML += char;
                }
                el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                await new Promise(r => setTimeout(r, _.random(CONFIG.typingDelay.min, CONFIG.typingDelay.max)));
            }
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.blur();

            this.agent.log(`Typed "${isCredential ? '******' : (textToType.length > 10 ? textToType.substring(0, 7) + '...' : textToType)}" into element ${elementId}.`, 'success');
            return `Successfully typed into element ${elementId}.`;
        }

        /**
         * Clicks on a specified element, ensuring it's visible and interactable.
         * @param {object} params - Action parameters.
         * @param {string} params.elementId - ID of the element.
         */
        async click({ elementId }) {
            const el = this.agent.domObserver.getElement(elementId);
            if (!el) throw new Error(`Element with ID ${elementId} not found.`);
            if (el.disabled) throw new Error(`Element ${elementId} is disabled.`);

            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 200));

            if (!this.agent.domObserver.isVisible(el)) {
                 throw new Error(`Element ${elementId} is not visible after scrolling.`);
            }

            el.click();
            this.agent.log(`Clicked element ${elementId}.`, 'success');
            return `Successfully clicked element ${elementId}.`;
        }

        /**
         * Selects an option from a dropdown (SELECT) element by its visible text.
         * @param {object} params - Action parameters.
         * @param {string} params.elementId - ID of the element.
         * @param {string} params.optionText - Text of the option to select.
         */
        async select({ elementId, optionText }) {
            const el = this.agent.domObserver.getElement(elementId);
            if (!el || el.tagName !== 'SELECT') throw new Error(`Select element with ID ${elementId} not found or is not a SELECT tag.`);
            if (el.disabled) throw new Error(`Select element ${elementId} is disabled.`);

            const option = Array.from(el.options).find(opt => opt.text.trim().toLowerCase() === optionText.toLowerCase());
            if (!option) throw new Error(`Option "${optionText}" not found in select element ${elementId}.`);

            el.value = option.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));

            this.agent.log(`Selected "${optionText}" in element ${elementId}.`, 'success');
            return `Successfully selected "${optionText}" in element ${elementId}.`;
        }

        /**
         * Navigates the browser to a new URL.
         * Adds error handling for navigation failure.
         * @param {object} params - Action parameters.
         * @param {string} params.url - URL to navigate to.
         * @returns {Promise<string>} A promise resolving with the observation.
         */
        async navigate({ url }) {
            this.agent.log(`Navigating to ${url}...`, 'info');
            try {
                window.location.href = url;
                // This promise will only resolve if the navigation happens and the page reloads
                // In practice, this will typically cause the userscript to reload.
                // We return a promise that resolves after a short delay, assuming navigation is initiating.
                await new Promise(r => setTimeout(r, CONFIG.postActionDelay * 2)); // Give it more time for navigation
                return `Successfully initiated navigation to ${url}.`;
            } catch (error) {
                throw new Error(`Failed to navigate to ${url}: ${error.message}`);
            }
        }

        /**
         * Verifies if a specific text is present anywhere on the current page.
         * @param {object} params - Action parameters.
         * @param {string} params.text - Text to verify.
         */
        verifyText({ text }) {
            const pageText = document.body.innerText || '';
            const found = pageText.includes(text);
            if (found) {
                this.agent.log(`Verification successful: Text "${text}" found.`, 'success');
                return `Successfully verified that text "${text}" is present on the page.`;
            } else {
                this.agent.log(`Verification failed: Text "${text}" not found.`, 'warn');
                return `Could not find the text "${text}" on the page.`;
            }
        }

        /**
         * Records a thought process step for the AI.
         * @param {object} params - Action parameters.
         * @param {string} params.thought - The AI's thought.
         */
        think({ thought }) {
            this.agent.log(`AI Thought: ${thought}`, 'system');
            this.agent.ui.updateReasoning(thought);
            return `Noted thought: ${thought}`;
        }

        /**
         * Halts the agent execution and logs the final summary.
         * @param {object} params - Action parameters.
         * @param {string} params.summary - Summary of the task outcome.
         */
        finish({ summary }) {
            this.agent.log(`Task Finished: ${summary}`, 'success');
            this.agent.ui.updateReasoning(`Task complete: ${summary}`);
            this.agent.stop('FINISH'); // Stop the agent's loop with a specific status
            return `Task finished with summary: ${summary}`;
        }
    }

    /**
     * Provides a comprehensive User Interface for the Gemini Web Agent,
     * including controls, logging, status indicators, and modal dialogs.
     */
    class AgentUI {
        /**
         * @param {(objective: string) => void} onCommand - Callback for submitting objectives.
         * @param {(newKey: string) => void} onKeyUpdate - Callback for updating API key.
         * @param {(position: {top: number, left: number}) => void} onPositionUpdate - Callback for saving UI position.
         */
        constructor(onCommand, onKeyUpdate, onPositionUpdate) {
            this.onCommand = onCommand;
            this.onKeyUpdate = onKeyUpdate;
            this.onPositionUpdate = onPositionUpdate;
            /** @type {Object.<string, HTMLElement>} */
            this.elements = {};
            this.isMinimized = CONFIG.uiMinimized;
            this.isDragging = false;
            this.offsetX = 0;
            this.offsetY = 0;
            this.init();
        }

        /** Initializes the UI by creating elements, attaching listeners, and applying styles. */
        init() {
            this.container = document.createElement('div');
            this.container.id = 'gwa-agent-ui-container';
            this.applyInitialPosition();
            document.body.appendChild(this.container);
            this.render();
            this.attachEventListeners();
            lucide.createIcons({ attrs: { 'class': 'gwa-icon' } });
            this.resetAgentStatuses();
            this.applyStyles(); // Inject CSS styles using a <style> tag
            this.toggleMinimize(this.isMinimized, true);
            this.updateStatusIndicator('idle'); // Start in idle state
        }

        /** Applies the initial position of the UI container, ensuring it's within viewport bounds. */
        applyInitialPosition() {
            const top = Math.max(0, Math.min(CONFIG.uiPosition.top, window.innerHeight - 100));
            const left = Math.max(0, Math.min(CONFIG.uiPosition.left, window.innerWidth - 300));
            this.container.style.top = `${top}px`;
            this.container.style.left = `${left}px`;
        }

        /** Renders the main HTML structure of the UI. */
        render() {
            this.container.innerHTML = `
                <div id="gwa-header">
                    <div class="gwa-header-title"><span data-lucide="brain-circuit"></span> Gemini Web Agent v5.3</div>
                    <div class="gwa-header-controls">
                        <div id="gwa-status-indicator" title="Agent Status (Green: Idle, Blue: Busy, Red: Stopped)"></div>
                        <button id="gwa-settings-button" title="Settings (API Key)"><span data-lucide="key"></span></button>
                        <button id="gwa-minimize-button" title="Toggle UI Visibility"><span data-lucide="chevron-down"></span></button>
                    </div>
                </div>
                <div id="gwa-body">
                    <div id="gwa-main-content">
                        <div class="gwa-panel gwa-reasoning-panel">
                            <h3><span data-lucide="lightbulb"></span>Reasoning</h3>
                            <div id="gwa-reasoning-output">Awaiting objective...</div>
                        </div>
                        <div class="gwa-panel gwa-log-panel">
                            <h3><span data-lucide="clipboard-list"></span>Execution Log</h3>
                            <div id="gwa-log-container"></div>
                        </div>
                    </div>
                    <div class="gwa-panel gwa-agents-panel">
                        <h3><span data-lucide="cpu"></span>Agent Modules</h3>
                        <div id="gwa-agents-list"></div>
                    </div>
                </div>
                <div id="gwa-input-area">
                    <input type="text" id="gwa-command-input" placeholder="Enter your high-level objective...">
                    <button id="gwa-submit-button" title="Execute Objective"><span data-lucide="play"></span></button>
                </div>
                <div id="gwa-modal-overlay" class="hidden">
                    <div id="gwa-modal-content"></div>
                </div>
            `;
        }

        /** Attaches all necessary event listeners to UI elements. */
        attachEventListeners() {
            const elIds = ['header', 'body', 'inputArea', 'commandInput', 'submitButton', 'minimizeButton', 'settingsButton', 'logContainer', 'agentsList', 'statusIndicator', 'reasoningOutput', 'modalOverlay', 'modalContent'];
            elIds.forEach(id => { this.elements[_.camelCase(id)] = document.getElementById(`gwa-${id}`); });

            this.elements.submitButton.addEventListener('click', () => this.submitObjective());
            this.elements.commandInput.addEventListener('keydown', (e) => e.key === 'Enter' && this.submitObjective());
            this.elements.minimizeButton.addEventListener('click', () => this.toggleMinimize());
            this.elements.settingsButton.addEventListener('click', () => this.showSettingsModal());
            this.elements.modalOverlay.addEventListener('click', (e) => {
                if (e.target === this.elements.modalOverlay) this.hideModal();
            });

            this.elements.header.addEventListener('mousedown', this.onDragStart.bind(this));
            document.addEventListener('mousemove', this.onDrag.bind(this));
            document.addEventListener('mouseup', this.onDragEnd.bind(this));
        }

        /** Handles submission of the user's objective from the input field. */
        submitObjective() {
            const command = this.elements.commandInput.value.trim();
            if (command && !this.elements.submitButton.disabled) {
                this.log(`Objective: ${command}`, 'user');
                this.onCommand(command);
                this.elements.commandInput.value = '';
            }
        }

        /** Toggles the minimized state of the UI. */
        toggleMinimize(forceState, isInitial = false) {
            this.isMinimized = forceState !== undefined ? forceState : !this.isMinimized;
            StorageManager.setValue('agentUIMinimized', this.isMinimized);
            this.container.classList.toggle('minimized', this.isMinimized);
            this.elements.body.style.display = this.isMinimized ? 'none' : 'flex';
            this.elements.inputArea.style.display = this.isMinimized ? 'none' : 'flex';
            this.elements.minimizeButton.innerHTML = this.isMinimized ? '<span data-lucide="chevron-up"></span>' : '<span data-lucide="chevron-down"></span>';
            lucide.createIcons();
        }

        /**
         * Logs a message to the UI's log container with appropriate icon and styling.
         * Includes timestamps and allows for filtering log levels.
         * @param {string} message - The message to log.
         * @param {'info'|'error'|'success'|'warn'|'user'|'system'|'debug'} level - The log level.
         */
        log(message, level = 'info') {
            const icons = { info: 'ℹ️', error: '❌', success: '✅', warn: '⚠️', user: '👤', system: '⚙️', debug: '🐛' };
            const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const logEntry = document.createElement('div');
            logEntry.className = `gwa-log-entry gwa-log-${level}`;
            logEntry.innerHTML = `<span class="gwa-log-timestamp">[${timestamp}]</span> <span class="gwa-log-icon">${icons[level] || 'ℹ️'}</span> <span class="gwa-log-message">${message}</span>`;
            this.elements.logContainer.appendChild(logEntry);
            this.elements.logContainer.scrollTop = this.elements.logContainer.scrollHeight;
        }

        /**
         * Updates the overall busy/idle/stopped status of the agent and disables/enables controls.
         * @param {'idle'|'busy'|'stopped'} status - The agent's current status.
         */
        setBusy(status) {
            this.updateStatusIndicator(status);
            const isBusy = (status === 'busy');
            this.elements.commandInput.disabled = isBusy;
            this.elements.submitButton.disabled = isBusy;
        }

        /**
         * Updates the color of the status indicator light.
         * @param {'idle'|'busy'|'stopped'} status - The agent's current status.
         */
        updateStatusIndicator(status) {
            this.elements.statusIndicator.className = ''; // Clear previous classes
            this.elements.statusIndicator.classList.add('gwa-status-indicator'); // Ensure base class
            this.elements.statusIndicator.classList.add(status);
        }

        /**
         * Updates the status text and active styling for a specific agent module.
         * @param {string} agentId - The ID of the agent module (e.g., 'observer', 'reasoning', 'executor').
         * @param {string} status - The status text to display.
         */
        updateAgentStatus(agentId, status) {
            this.elements.agentsList.querySelectorAll('.gwa-agent-item').forEach(el => el.classList.remove('active'));
            const agentEl = document.getElementById(`gwa-agent-${agentId}`);
            if (agentEl) {
                agentEl.querySelector('.gwa-agent-status').textContent = status;
                agentEl.classList.add('active');
            }
        }

        /**
         * Updates the text displayed in the reasoning panel.
         * @param {string} text - The reasoning text.
         */
        updateReasoning(text) {
            this.elements.reasoningOutput.textContent = text;
        }

        /** Renders the list of agent modules (Observer, Core, Executor) in the UI. */
        resetAgentStatuses() {
            const modules = [
                { id: 'observer', name: 'DOM Observer', specialty: 'Web Perception' },
                { id: 'reasoning', name: 'Gemini Core', specialty: 'Decision Making' },
                { id: 'executor', name: 'Action Executor', specialty: 'Task Execution' },
            ];
            this.elements.agentsList.innerHTML = modules.map(mod => `
                <div class="gwa-agent-item" id="gwa-agent-${mod.id}">
                    <div class="gwa-agent-main">
                        <span class="gwa-agent-name">${mod.name}</span>
                        <span class="gwa-agent-status">idle</span>
                    </div>
                    <div class="gwa-agent-details">
                        <span class="gwa-agent-specialty">${mod.specialty}</span>
                    </div>
                </div>
            `).join('');
        }

        /** Displays the settings modal to allow the user to input their Gemini API key. */
        showSettingsModal() {
            const modalContent = this.elements.modalContent;
            modalContent.innerHTML = `
                <h2>Settings</h2>
                <label for="gemini-api-key-input">Google Gemini API Key:</label>
                <input type="password" id="gemini-api-key-input" placeholder="Enter your API Key" value="${CONFIG.geminiApiKey}">
                <p class="gwa-modal-note">Your key is stored securely using Tampermonkey's GM_setValue.</p>
                <div class="gwa-modal-buttons">
                    <button id="gwa-save-settings-btn">Save</button>
                    <button id="gwa-close-modal-btn">Cancel</button>
                </div>
            `;
            this.elements.modalOverlay.classList.remove('hidden');

            document.getElementById('gemini-api-key-input').focus();
            document.getElementById('gwa-save-settings-btn').onclick = () => {
                const newKey = document.getElementById('gemini-api-key-input').value;
                this.onKeyUpdate(newKey);
                this.hideModal();
            };
            document.getElementById('gwa-close-modal-btn').onclick = () => this.hideModal();
        }

        /**
         * Prompts the user for sensitive credential input via a modal dialog.
         * Allows for different input types (e.g., text, number) beyond just password.
         * @param {string} type - The type of credential requested (e.g., 'password', 'email', 'phone', 'number').
         * @returns {Promise<string|null>} The entered credential or null if cancelled.
         */
        promptForCredential(type) {
            return new Promise(resolve => {
                const inputType = (type === 'password') ? 'password' : 'text'; // Default to text for non-password types
                const modalContent = this.elements.modalContent;
                modalContent.innerHTML = `
                    <h2>Credential Required</h2>
                    <p>Please enter your ${type} to proceed:</p>
                    <input type="${inputType}" id="credential-input-field" placeholder="Enter ${type}">
                    <div class="gwa-modal-buttons">
                        <button id="credential-submit-btn">Submit</button>
                        <button id="credential-cancel-btn">Cancel</button>
                    </div>
                `;
                this.elements.modalOverlay.classList.remove('hidden');

                const submitBtn = document.getElementById('credential-submit-btn');
                const cancelBtn = document.getElementById('credential-cancel-btn');
                const inputField = document.getElementById('credential-input-field');

                const handleSubmit = () => {
                    const value = inputField.value;
                    this.hideModal();
                    resolve(value);
                    cleanup();
                };
                const handleCancel = () => {
                    this.hideModal();
                    resolve(null);
                    cleanup();
                };
                const cleanup = () => {
                    submitBtn.removeEventListener('click', handleSubmit);
                    cancelBtn.removeEventListener('click', handleCancel);
                    inputField.removeEventListener('keydown', handleEnter);
                };
                const handleEnter = (e) => e.key === 'Enter' && handleSubmit();

                submitBtn.addEventListener('click', handleSubmit);
                cancelBtn.addEventListener('click', handleCancel);
                inputField.addEventListener('keydown', handleEnter);
                inputField.focus();
            });
        }

        /** Hides the modal overlay and clears its content. */
        hideModal() {
            this.elements.modalOverlay.classList.add('hidden');
            this.elements.modalContent.innerHTML = '';
        }

        /** Injects all necessary CSS styles for the UI components using a <style> tag. */
        applyStyles() {
            const styleId = 'gwa-agent-ui-style';
            if (document.getElementById(styleId)) return; // Prevent duplicate injection

            const styleTag = document.createElement('style');
            styleTag.id = styleId;
            styleTag.textContent = `
                :root {
                    --gwa-bg-dark: #111827;
                    --gwa-bg-med: #1f2937;
                    --gwa-bg-light: #374151;
                    --gwa-border: #4b5563;
                    --gwa-text-primary: #d1d5db;
                    --gwa-text-secondary: #9ca3af;
                    --gwa-accent-blue: #3b82f6;
                    --gwa-accent-green: #22c55e;
                    --gwa-accent-red: #ef4444;
                    --gwa-accent-yellow: #f59e0b;
                    --gwa-accent-purple: #8b5cf6;
                    --gwa-accent-gray: #6b7280;
                }

                #gwa-agent-ui-container {
                    position: fixed;
                    top: ${CONFIG.uiPosition.top}px;
                    left: ${CONFIG.uiPosition.left}px;
                    width: 700px;
                    background-color: var(--gwa-bg-dark);
                    color: var(--gwa-text-primary);
                    border: 1px solid var(--gwa-bg-light);
                    border-radius: 12px;
                    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    transition: width 0.3s ease, height 0.3s ease, top 0.3s ease, left 0.3s ease;
                    z-index: 99999;
                    max-height: 80vh;
                }

                #gwa-agent-ui-container.minimized {
                    width: 300px;
                    height: 40px;
                    border-radius: 50px;
                    box-shadow: 0 4px 15px rgba(0,0,0,.3);
                }

                #gwa-header {
                    background-color: var(--gwa-bg-med);
                    padding: 10px 15px;
                    font-weight: 600;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    cursor: grab;
                    flex-shrink: 0;
                    border-bottom: 1px solid var(--gwa-border);
                    border-top-left-radius: 12px;
                    border-top-right-radius: 12px;
                    height: 40px;
                    box-sizing: border-box;
                }
                #gwa-agent-ui-container.minimized #gwa-header {
                    border-radius: 50px;
                    border-bottom: none;
                }

                .gwa-header-title { display: flex; align-items: center; gap: 8px; font-size: 16px; }
                .gwa-header-title .gwa-icon { width: 20px; height: 20px; }
                .gwa-header-controls { display: flex; align-items: center; gap: 10px; }

                #gwa-minimize-button, #gwa-settings-button {
                    background: none; border: none; color: var(--gwa-text-secondary);
                    cursor: pointer; padding: 4px; display: flex; align-items: center;
                    justify-content: center; border-radius: 4px; transition: background-color 0.2s ease, color 0.2s ease;
                }
                #gwa-minimize-button:hover, #gwa-settings-button:hover { background-color: var(--gwa-bg-light); color: #fff; }
                #gwa-minimize-button .gwa-icon, #gwa-settings-button .gwa-icon { width: 18px; height: 18px; }

                .gwa-status-indicator {
                    width: 14px; height: 14px; border-radius: 50%;
                    transition: background-color 0.3s ease, box-shadow 0.3s ease;
                    margin-right: 5px;
                }
                .gwa-status-indicator.idle { background-color: var(--gwa-accent-green); }
                .gwa-status-indicator.busy {
                    background-color: var(--gwa-accent-blue);
                    animation: gwa-pulse 1.5s infinite;
                }
                .gwa-status-indicator.stopped { background-color: var(--gwa-accent-red); }

                @keyframes gwa-pulse {
                    0%, 100% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); }
                    70% { box-shadow: 0 0 0 8px rgba(59, 130, 246, 0); }
                }

                #gwa-body {
                    display: flex; padding: 15px; gap: 15px; flex-grow: 1;
                    overflow-y: auto;
                    background-color: var(--gwa-bg-dark);
                }
                #gwa-agent-ui-container.minimized #gwa-body { display: none; }

                #gwa-main-content { flex: 2; display: flex; flex-direction: column; gap: 15px; min-width: 0; }
                .gwa-agents-panel { flex: 1; min-width: 0; }

                .gwa-panel {
                    background-color: var(--gwa-bg-med);
                    border-radius: 8px; padding: 12px;
                    border: 1px solid var(--gwa-border);
                }
                .gwa-panel h3 {
                    margin: 0 0 10px; font-size: 16px; font-weight: 600;
                    display: flex; align-items: center; gap: 6px;
                    color: var(--gwa-text-primary);
                    border-bottom: 1px solid var(--gwa-bg-light); padding-bottom: 8px;
                }
                .gwa-panel h3 .gwa-icon { width: 18px; height: 18px; color: var(--gwa-accent-blue); }

                #gwa-reasoning-output {
                    height: 80px; overflow-y: auto; font-style: italic;
                    color: var(--gwa-text-secondary); padding: 8px;
                    border-radius: 4px; background-color: var(--gwa-bg-dark);
                    font-size: 13px; line-height: 1.5;
                }

                #gwa-log-container {
                    height: 200px; overflow-y: auto; font-family: monospace;
                    font-size: 13px; scrollbar-width: thin; scrollbar-color: var(--gwa-border) var(--gwa-bg-med);
                }
                #gwa-log-container::-webkit-scrollbar { width: 8px; }
                #gwa-log-container::-webkit-scrollbar-track { background: var(--gwa-bg-med); border-radius: 4px; }
                #gwa-log-container::-webkit-scrollbar-thumb { background: var(--gwa-border); border-radius: 4px; }
                #gwa-log-container::-webkit-scrollbar-thumb:hover { background: var(--gwa-accent-gray); }

                .gwa-log-entry {
                    margin-bottom: 8px; line-height: 1.4; display: flex;
                    align-items: flex-start;
                    gap: 8px; word-break: break-word;
                    padding: 4px 2px; border-radius: 3px;
                }
                .gwa-log-entry:hover { background-color: rgba(255, 255, 255, 0.05); }
                .gwa-log-entry .gwa-log-timestamp {
                    font-size: 10px;
                    color: var(--gwa-text-secondary);
                    flex-shrink: 0;
                }
                .gwa-log-entry .gwa-log-icon { flex-shrink: 0; margin-top: 2px; }
                .gwa-log-entry .gwa-log-message { flex-grow: 1; }

                .gwa-log-info { color: var(--gwa-text-secondary); }
                .gwa-log-user { color: var(--gwa-accent-purple); }
                .gwa-log-warn { color: var(--gwa-accent-yellow); }
                .gwa-log-error { color: var(--gwa-accent-red); font-weight: bold; }
                .gwa-log-success { color: var(--gwa-accent-green); }
                .gwa-log-system { color: var(--gwa-accent-blue); }
                .gwa-log-debug { color: var(--gwa-accent-gray); }

                #gwa-agents-list {
                    display: flex; flex-direction: column; gap: 8px;
                }
                .gwa-agent-item {
                    background-color: var(--gwa-bg-light);
                    border-left: 4px solid var(--gwa-border);
                    padding: 10px 12px;
                    border-radius: 5px;
                    transition: all 0.2s ease;
                    cursor: default;
                }
                .gwa-agent-item.active {
                    border-left-color: var(--gwa-accent-blue);
                    background-color: rgba(59, 130, 246, 0.2);
                }
                .gwa-agent-main {
                    display: flex; align-items: center; justify-content: space-between;
                    font-weight: 500; font-size: 14px; margin-bottom: 4px;
                }
                .gwa-agent-name { color: var(--gwa-text-primary); }
                .gwa-agent-status {
                    font-size: 12px; color: var(--gwa-text-secondary); text-transform: capitalize;
                }
                .gwa-agent-details {
                    display: flex; justify-content: space-between; align-items: center;
                    font-size: 11px; color: var(--gwa-text-secondary);
                }
                .gwa-agent-specialty { font-style: italic; opacity: 0.8; }

                #gwa-input-area {
                    display: flex; border-top: 1px solid var(--gwa-bg-light);
                    background-color: var(--gwa-bg-med); padding: 10px 15px;
                    border-bottom-left-radius: 12px; border-bottom-right-radius: 12px;
                    height: 50px; box-sizing: border-box;
                }
                #gwa-agent-ui-container.minimized #gwa-input-area { display: none; }

                #gwa-command-input {
                    flex-grow: 1; background: none; border: none;
                    color: var(--gwa-text-primary); outline: none;
                    font-size: 14px; padding: 5px 10px; margin-right: 10px;
                }
                #gwa-command-input:focus {
                    outline: 1px solid var(--gwa-accent-blue); border-radius: 3px;
                }
                #gwa-command-input:disabled {
                    background-color: var(--gwa-bg-dark); opacity: 0.6; cursor: not-allowed;
                }

                #gwa-submit-button {
                    background-color: var(--gwa-accent-blue); color: #fff; border: none;
                    border-radius: 6px; padding: 8px 15px; cursor: pointer;
                    font-size: 16px; display: flex; align-items: center;
                    justify-content: center; transition: background-color 0.2s ease;
                }
                #gwa-submit-button:hover:not(:disabled) { background-color: #2563eb; }
                #gwa-submit-button:disabled {
                    background-color: var(--gwa-bg-light); cursor: not-allowed; opacity: 0.7;
                }
                #gwa-submit-button .gwa-icon { width: 16px; height: 16px; margin-left: 5px; }

                #gwa-modal-overlay {
                    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                    background: rgba(0, 0, 0, 0.7); z-index: 100000;
                    display: flex; align-items: center; justify-content: center;
                    backdrop-filter: blur(5px);
                }
                #gwa-modal-overlay.hidden { display: none; }

                #gwa-modal-content {
                    background: var(--gwa-bg-med); padding: 25px;
                    border-radius: 10px; width: 400px; max-width: 90%;
                    border: 1px solid var(--gwa-border); box-shadow: 0 5px 20px rgba(0,0,0,.4);
                    display: flex; flex-direction: column; gap: 10px;
                }
                #gwa-modal-content h2 {
                    margin-top: 0; color: var(--gwa-text-primary); font-size: 20px;
                    border-bottom: 1px solid var(--gwa-bg-light); padding-bottom: 10px; margin-bottom: 15px;
                }
                #gwa-modal-content label {
                    display: block; margin-bottom: 5px; color: var(--gwa-text-primary); font-weight: 500;
                }
                #gwa-modal-content input[type="password"], #gwa-modal-content input[type="text"] {
                    width: 100%; padding: 10px 12px; background: var(--gwa-bg-dark);
                    border: 1px solid var(--gwa-border); border-radius: 5px;
                    color: var(--gwa-text-primary); box-sizing: border-box; font-size: 14px;
                }
                #gwa-modal-content input:focus {
                    outline: none; border-color: var(--gwa-accent-blue);
                    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
                }
                .gwa-modal-note { font-size: 12px; color: var(--gwa-text-secondary); margin-bottom: 15px; }
                .gwa-modal-buttons {
                    display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px;
                }
                .gwa-modal-buttons button {
                    padding: 8px 16px; border: none; border-radius: 5px; cursor: pointer;
                    font-weight: 500; transition: background-color 0.2s ease;
                }
                #gwa-save-settings-btn, #credential-submit-btn { background-color: var(--gwa-accent-blue); color: #fff; }
                #gwa-save-settings-btn:hover, #credential-submit-btn:hover { background-color: #2563eb; }
                #gwa-close-modal-btn, #credential-cancel-btn { background-color: var(--gwa-bg-light); color: var(--gwa-text-primary); }
                #gwa-close-modal-btn:hover, #credential-cancel-btn:hover { background-color: var(--gwa-border); }
            `;
            document.head.appendChild(styleTag);
        }

        /** Handles the start of a drag operation on the header. */
        onDragStart(e) {
            if (e.target.closest('button')) return;
            this.isDragging = true;
            const rect = this.container.getBoundingClientRect();
            this.offsetX = e.clientX - rect.left;
            this.offsetY = e.clientY - rect.top;
            this.container.style.cursor = 'grabbing';
            e.preventDefault();
        }

        /** Updates the UI container's position during dragging. */
        onDrag(e) {
            if (!this.isDragging) return;
            let newX = e.clientX - this.offsetX;
            let newY = e.clientY - this.offsetY;

            const maxX = window.innerWidth - this.container.offsetWidth;
            const maxY = window.innerHeight - this.container.offsetHeight;
            newX = Math.max(0, Math.min(newX, maxX));
            newY = Math.max(0, Math.min(newY, maxY));

            this.container.style.left = `${newX}px`;
            this.container.style.top = `${newY}px`;
        }

        /** Handles the end of a drag operation, saving the final position. */
        onDragEnd() {
            if (this.isDragging) {
                this.isDragging = false;
                this.container.style.cursor = 'grab';
                const finalPosition = {
                    top: parseFloat(this.container.style.top),
                    left: parseFloat(this.container.style.left)
                };
                StorageManager.setValue('agentUIPosition', finalPosition);
                this.onPositionUpdate(finalPosition);
            }
        }
    }


    /**
     * Orchestrates the entire Gemini Web Agent workflow, managing the lifecycle
     * of its core modules and handling user interactions.
     */
    class GeminiWebAgent {
        constructor() {
            console.log("[GeminiWebAgent v5.3] Initializing...");
            /** @type {boolean} */
            this.isRunning = false;
            /** @type {string} */
            this.currentObjective = "";
            /** @type {number|null} */
            this.agentLoopTimeout = null; // Changed to setTimeout for single execution steps
            /** @type {number|null} */
            this.executionTimer = null; // Timer for MAX_EXECUTION_TIME

            // Instantiate core modules
            this.memory = new MemoryManager(BASE_PROFILE);
            this.domObserver = new DOMObserver(this);
            this.geminiCore = new GeminiCore(this);
            this.actionExecutor = new ActionExecutor(this);

            // Instantiate UI and pass necessary callbacks
            this.ui = new AgentUI(
                this.start.bind(this),
                this.updateApiKey.bind(this),
                this.updateUIPosition.bind(this)
            );

            if (!CONFIG.geminiApiKey) {
                this.log('Welcome! Please set your Google Gemini API key in the settings (🔑) to begin.', 'warn');
            } else {
                this.log(`Gemini Web Agent is ready. Please provide an objective.`, 'system');
            }

            this.domObserver.start(); // Always start observing DOM
        }

        /**
         * Logs messages through the UI component.
         * @param {string} message - The message to log.
         * @param {'info'|'error'|'success'|'warn'|'user'|'system'|'debug'} level - The log level.
         */
        log(message, level) { this.ui.log(message, level); }

        /**
         * Updates the Gemini API key and persists it.
         * @param {string} newKey - The new API key.
         */
        updateApiKey(newKey) {
            CONFIG.geminiApiKey = newKey;
            StorageManager.setValue('geminiApiKey', newKey);
            this.geminiCore.updateApiKey(newKey); // Update GeminiCore's API key
            this.log('API Key updated successfully.', 'success');

            if (this.currentObjective && !this.isRunning && newKey) {
                this.log('API key set/updated. Attempting to resume objective...', 'info');
                this.start(this.currentObjective);
            }
        }

        /**
         * Callback to acknowledge UI position updates.
         * @param {{top: number, left: number}} newPosition - The new UI position.
         */
        updateUIPosition(newPosition) {
            this.log(`UI position updated to ${newPosition.top}px, ${newPosition.left}px`, 'debug');
        }

        /**
         * Starts the agent processing for a given user objective.
         * @param {string} objective - The high-level task the agent should perform.
         */
        start(objective) {
            if (this.isRunning) {
                this.log('An objective is already in progress. Please wait for it to complete or stop it.', 'warn');
                return;
            }
            if (!CONFIG.geminiApiKey) {
                this.log('Cannot start: Gemini API Key is not set. Please configure it first.', 'error');
                this.ui.showSettingsModal();
                return;
            }

            this.currentObjective = objective;
            this.isRunning = true;
            this.memory.clearHistory(); // Clear previous history for the new task
            this.ui.setBusy('busy'); // Update UI to indicate agent is busy
            this.log(`Objective set: "${objective}"`, 'system');

            // Start the max execution time safeguard
            this.executionTimer = setTimeout(() => {
                this.log(`Agent stopped: Exceeded MAX_EXECUTION_TIME (${CONFIG.maxExecutionTime / 1000} seconds).`, 'error');
                this.stop('AGENT_STOPPED');
            }, CONFIG.maxExecutionTime);

            this.agentLoop(); // Initiate the agent's execution loop
        }

        /**
         * Stops the agent's execution loop and gracefully cleans up resources.
         * @param {'FINISH'|'AGENT_STOPPED'|'ERROR'} [reason='AGENT_STOPPED'] - The reason for stopping.
         */
        stop(reason = 'AGENT_STOPPED') {
            this.isRunning = false;

            if (this.agentLoopTimeout) {
                clearTimeout(this.agentLoopTimeout);
                this.agentLoopTimeout = null;
            }
            if (this.executionTimer) {
                clearTimeout(this.executionTimer);
                this.executionTimer = null;
            }

            // Clean up event listeners if any were dynamically added during execution (e.g., for specific interaction patterns)
            // Currently, no dynamic listeners are added by agent, but good to have a placeholder.

            this.ui.setBusy('stopped');
            this.ui.resetAgentStatuses();
            this.log(`Agent has stopped execution. Reason: ${reason}.`, 'system');
        }

        /** The main execution loop of the agent. */
        agentLoop() {
            if (!this.isRunning) {
                this.log('Agent is not running, stopping loop.', 'debug');
                return;
            }

            // Phase 1: Observe the current page state
            this.ui.updateAgentStatus('observer', 'Scanning...');
            const pageState = this.domObserver.observe();

            // Phase 2: Decide the next action using Gemini
            this.ui.updateAgentStatus('reasoning', 'Deciding...');
            this.geminiCore.decideNextAction(
                this.currentObjective,
                pageState,
                this.memory.getHistory()
            ).then(nextAction => {
                if (!this.isRunning) {
                    this.log('Agent was stopped during decision making.', 'debug');
                    return;
                }

                // Phase 3: Execute the decided action
                this.ui.updateAgentStatus('executor', 'Executing...');
                this.actionExecutor.execute(nextAction)
                    .then(observation => {
                        this.memory.addHistory(nextAction, observation);

                        if (nextAction.action !== 'FINISH') {
                            this.agentLoopTimeout = setTimeout(() => this.agentLoop(), CONFIG.postActionDelay);
                        } else {
                            this.stop('FINISH');
                        }
                    })
                    .catch(execError => {
                        this.log(`Error during action execution: ${execError.message}`, 'error');
                        this.stop('ERROR');
                    });
            }).catch(thinkError => {
                this.log(`Error during Gemini decision making: ${thinkError.message}`, 'error');
                this.stop('ERROR');
            });
        }
    }

    // --- SCRIPT INITIALIZATION ---
    /**
     * Prevents re-initialization of the agent if the script runs multiple times
     * (e.g., due to SPA navigations or browser weirdness).
     * Initializes the agent after the page is fully loaded.
     */
    const initializeAgent = () => {
        if (window.geminiWebAgentInstance) {
             console.log("[GeminiWebAgent v5.3] Instance already running, skipping re-initialization.");
        } else {
            window.geminiWebAgentInstance = new GeminiWebAgent();
        }
    };

    // Use a small delay to ensure DOM is fully ready and avoid potential race conditions
    // 'document-idle' should already provide a good timing, but an extra setTimeout can help
    // for complex pages or if other scripts are still loading.
    window.addEventListener('load', () => {
        setTimeout(initializeAgent, 500); // 500ms delay after load event
    });

    // Handle potential SPA navigations or history changes.
    // This is a basic approach; a more robust solution might involve
    // detecting specific SPA framework events or more granular URL changes.
    // For now, we rely on the MutationObserver and periodic scans to adapt.
    window.addEventListener('popstate', () => {
        console.log("Gemini Web Agent: Popstate event detected. Forcing DOM re-scan.");
        if (window.geminiWebAgentInstance && window.geminiWebAgentInstance.domObserver) {
            window.geminiWebAgentInstance.domObserver.observe();
        }
    });

    // Also listen for pushState/replaceState if possible (needs overriding browser functions)
    // This is a more advanced technique not directly part of a basic userscript.
    // For simplicity, we assume MutationObserver and periodic scans handle most changes.

})();
