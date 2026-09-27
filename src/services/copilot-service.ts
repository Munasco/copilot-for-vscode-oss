import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

// SDK types - loaded dynamically since the SDK is ESM-only
type CopilotClient = any;
type CopilotSession = any;
type SessionEvent = any;

// Import types
import type { FileAttachment, ChatMessage, ToolEvent, ModelOption } from '../types/messages';

/**
 * Structure for grouping session events into conversation turns
 */
interface ConversationTurn {
    userMessage: any | null;
    assistantMessages: any[];
    toolExecutions: Map<string, { start?: any; complete?: any }>;
    activeModel: string | null;  // Track which model was active during this turn
}

/**
 * Service wrapper for GitHub Copilot SDK integration.
 * Handles session management, streaming, and message routing.
 * 
 * Note: The @github/copilot-sdk is an ESM-only module, so we must use
 * dynamic import() to load it in the CommonJS VS Code extension environment.
 */
export class CopilotService {
    private client: CopilotClient | null = null;
    private session: CopilotSession | null = null;
    private webview: vscode.Webview | null = null;
    private currentMessageId: string | null = null;
    private currentModel: string | null = null;
    private isInitialized = false;
    private CopilotClientClass: any = null;
    // Track pending tool calls so completion events can access tool info
    private pendingToolCalls: Map<string, { toolName: string; arguments: any }> = new Map();
    // Track current system message for session
    private currentSystemMessage: string | undefined = undefined;

    /**
     * Resolves the copilot CLI executable and environment variables (including PATH)
     */
    private resolveCliConfig(): { cliPath: string; env: NodeJS.ProcessEnv } {
        const config = vscode.workspace.getConfiguration('copilot-oss');
        const configuredPath = config.get<string>('cliPath');
        const home = os.homedir();

        const searchDirs: string[] = [
            '/opt/homebrew/bin',
            '/usr/local/bin',
            path.join(home, '.local/bin'),
            path.join(home, 'bin'),
            path.join(home, '.volta/bin'),
            path.join(home, '.asdf/shims')
        ];

        // Search NVM node versions
        const nvmBase = path.join(home, '.nvm/versions/node');
        if (fs.existsSync(nvmBase)) {
            try {
                const versions = fs.readdirSync(nvmBase);
                for (const v of versions) {
                    searchDirs.unshift(path.join(nvmBase, v, 'bin'));
                }
            } catch {}
        }

        // Search FNM
        const fnmBase = path.join(home, '.local/share/fnm/current/bin');
        if (fs.existsSync(fnmBase)) {
            searchDirs.unshift(fnmBase);
        }

        let resolvedCliPath: string | null = null;
        let binDir: string | null = null;

        if (configuredPath && fs.existsSync(configuredPath)) {
            resolvedCliPath = configuredPath;
            binDir = path.dirname(configuredPath);
        } else {
            for (const dir of searchDirs) {
                const candidate = path.join(dir, 'copilot');
                if (fs.existsSync(candidate)) {
                    resolvedCliPath = candidate;
                    binDir = dir;
                    break;
                }
            }

            // Fallback: ask login shell
            if (!resolvedCliPath && process.platform !== 'win32') {
                try {
                    const shell = process.env.SHELL || '/bin/zsh';
                    const stdout = cp.execSync(`${shell} -l -c "which copilot"`, {
                        encoding: 'utf8',
                        timeout: 3000
                    }).trim();
                    if (stdout && fs.existsSync(stdout)) {
                        resolvedCliPath = stdout;
                        binDir = path.dirname(stdout);
                    }
                } catch {}
            }
        }

        const finalCliPath = resolvedCliPath || 'copilot';

        // Augment PATH to ensure node and copilot binaries are accessible to spawned subshell
        const extraPaths = [
            binDir,
            ...searchDirs,
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin',
            '/bin',
            '/usr/sbin',
            '/sbin'
        ].filter(Boolean) as string[];

        const currentPath = process.env.PATH || '';
        const augmentedPath = Array.from(new Set([...extraPaths, ...currentPath.split(path.delimiter)])).join(path.delimiter);

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: augmentedPath
        };

        console.log('[CopilotService] Resolved CLI Path:', finalCliPath);
        return { cliPath: finalCliPath, env };
    }

    /**
     * Sets the webview instance for sending messages
     */
    setWebview(webview: vscode.Webview): void {
        this.webview = webview;
    }

    /**
     * Initializes the Copilot client and logs connection state
     */
    async initialize(): Promise<void> {
        if (this.isInitialized && this.client) {
            return;
        }

        try {
            // Dynamic import of the ESM-only SDK
            const importDynamic = new Function('specifier', 'return import(specifier)');
            const sdk = await importDynamic('@github/copilot-sdk');
            this.CopilotClientClass = sdk.CopilotClient;

            // Determine working directory: first workspace folder or user home
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const cwd = workspaceFolders && workspaceFolders.length > 0
                ? workspaceFolders[0].uri.fsPath
                : os.homedir();
            console.log('[CopilotService] Using working directory:', cwd);

            const { cliPath, env } = this.resolveCliConfig();

            // Create the Copilot client with the working directory, resolved CLI path, and augmented env
            this.client = new this.CopilotClientClass({
                cwd,
                cliPath,
                env
            });

            // Start the client (connects to Copilot CLI server)
            await this.client.start();

            // Check authentication status
            try {
                if (typeof this.client.getAuthStatus === 'function') {
                    const authStatus = await this.client.getAuthStatus();
                    console.log('[CopilotService] Auth status:', authStatus);
                    if (authStatus && !authStatus.isAuthenticated) {
                        vscode.window.showWarningMessage('GitHub Copilot CLI is not authenticated. Please run "copilot" in your terminal to log in.');
                    }
                }
            } catch (authErr) {
                console.warn('[CopilotService] Unable to check auth status:', authErr);
            }

            this.isInitialized = true;
            console.log('[CopilotService] Copilot SDK initialized successfully');
        } catch (error) {
            console.error('[CopilotService] Failed to initialize Copilot client:', error);
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to initialize Copilot SDK: ${msg}`);
        }
    }

    private parseModelSelection(model: string): { actualModel: string; autoTier: string | null } {
        if (model.startsWith('auto:')) {
            const tier = model.substring(5);
            return {
                actualModel: 'auto',
                autoTier: tier === 'default' ? null : tier
            };
        }
        if (model === 'auto') {
            return { actualModel: 'auto', autoTier: null };
        }
        return { actualModel: model, autoTier: null };
    }

    /**
     * Creates a new session with the specified model and optional system message
     */
    async createSession(model: string, systemMessage?: string): Promise<void> {
        if (!this.client) {
            await this.initialize();
        }

        // Close existing session if any
        if (this.session) {
            try {
                if (typeof this.session.disconnect === 'function') {
                    await this.session.disconnect();
                } else if (typeof this.session.destroy === 'function') {
                    await this.session.destroy();
                }
            } catch (err) {
                console.warn('[CopilotService] Error disconnecting existing session:', err);
            }
            this.session = null;
        }

        const { actualModel, autoTier } = this.parseModelSelection(model);

        try {
            // Build session configuration
            const sessionConfig: any = {
                model: actualModel,
                streaming: true,
            };

            // Add custom system message if provided using 'append' mode
            if (systemMessage && systemMessage.trim()) {
                sessionConfig.systemMessage = {
                    mode: 'append',
                    content: systemMessage.trim()
                };
            }

            // Create session with the SDK
            this.session = await this.client!.createSession(sessionConfig);

            // Set autoTier if auto model
            if (actualModel === 'auto' && typeof this.session.setAutoTier === 'function') {
                try {
                    await this.session.setAutoTier(autoTier);
                    console.log(`[CopilotService] Auto tier set to: ${autoTier}`);
                } catch (err) {
                    console.warn(`[CopilotService] Failed to set auto tier ${autoTier}:`, err);
                }
            }

            // Subscribe to session events
            this.session.on(this.handleEvent.bind(this));

            // Store current model and system message
            this.currentModel = model;
            this.currentSystemMessage = systemMessage;

            console.log(`[CopilotService] Session created with model: ${model}${autoTier ? ` (tier: ${autoTier})` : ''}${systemMessage ? ', with custom system message' : ''}`);
        } catch (error) {
            console.error('[CopilotService] Failed to create session:', error);
            throw error;
        }
    }

    /**
     * Handles events from the Copilot session
     */
    private handleEvent(event: SessionEvent): void {
        if (!this.webview) {
            return;
        }

        // Log all events for debugging
        console.log('[CopilotService] Session event:', event.type, event.data);

        switch (event.type) {
            case 'session.auto_mode_resolved': {
                const chosen = event.data?.chosenModel || event.data?.model;
                if (chosen && this.currentMessageId) {
                    const label = this.currentModel?.startsWith('auto:')
                        ? `Auto [${this.currentModel.substring(5)}] (${chosen})`
                        : `Auto (${chosen})`;
                    this.webview.postMessage({
                        type: 'updateMessageModel',
                        messageId: this.currentMessageId,
                        model: label
                    });
                }
                break;
            }

            case 'assistant.usage': {
                const model = event.data?.model;
                if (model && this.currentMessageId && (this.currentModel === 'auto' || this.currentModel?.startsWith('auto:'))) {
                    const label = this.currentModel.startsWith('auto:')
                        ? `Auto [${this.currentModel.substring(5)}] (${model})`
                        : `Auto (${model})`;
                    this.webview.postMessage({
                        type: 'updateMessageModel',
                        messageId: this.currentMessageId,
                        model: label
                    });
                }
                break;
            }

            case 'model.message': {
                const model = event.data?.modelCall?.model;
                if (model && this.currentMessageId && (this.currentModel === 'auto' || this.currentModel?.startsWith('auto:'))) {
                    const label = this.currentModel.startsWith('auto:')
                        ? `Auto [${this.currentModel.substring(5)}] (${model})`
                        : `Auto (${model})`;
                    this.webview.postMessage({
                        type: 'updateMessageModel',
                        messageId: this.currentMessageId,
                        model: label
                    });
                }
                break;
            }

            case 'assistant.message_delta':
                // Streaming chunk
                this.webview.postMessage({
                    type: 'streamChunk',
                    messageId: this.currentMessageId,
                    content: event.data.deltaContent
                });
                break;

            case 'assistant.message':
                // Complete message
                this.webview.postMessage({
                    type: 'streamEnd',
                    messageId: this.currentMessageId,
                    content: event.data.content
                });
                break;

            case 'session.idle':
                // Generation complete
                this.webview.postMessage({
                    type: 'generationComplete'
                });
                this.currentMessageId = null;
                break;

            case 'session.usage_info': {
                // Context window usage info - forward to webview for display
                const { tokenLimit, currentTokens, messagesLength } = event.data;
                const percentage = tokenLimit > 0 ? Math.round((currentTokens / tokenLimit) * 100) : 0;
                this.webview.postMessage({
                    type: 'contextUsageUpdate',
                    usage: {
                        tokenLimit,
                        currentTokens,
                        messagesLength,
                        percentage
                    }
                });
                break;
            }

            case 'tool.execution_start':
                // Skip internal SDK tools
                if (this.isInternalTool(event.data.toolName)) {
                    break;
                }
                // Cache tool info for completion event
                this.pendingToolCalls.set(event.data.toolCallId, {
                    toolName: event.data.toolName,
                    arguments: event.data.arguments || {}
                });
                this.webview.postMessage({
                    type: 'toolEvent',
                    messageId: this.currentMessageId,
                    event: this.createToolEvent(event.data, 'loading')
                });
                break;

            case 'tool.execution_complete': {
                // Get cached tool info since completion events don't include toolName
                const cachedInfo = this.pendingToolCalls.get(event.data.toolCallId);
                if (!cachedInfo) {
                    // Skip if we don't have cached info (likely an internal tool)
                    break;
                }
                // Merge cached info with completion data
                const completeData = {
                    ...event.data,
                    toolName: cachedInfo.toolName,
                    arguments: cachedInfo.arguments
                };
                this.pendingToolCalls.delete(event.data.toolCallId);
                this.webview.postMessage({
                    type: 'toolEvent',
                    messageId: this.currentMessageId,
                    event: this.createToolEvent(completeData, event.data.success ? 'success' : 'error')
                });
                break;
            }

            case 'assistant.reasoning_delta':
                // Streaming reasoning chunk
                this.webview.postMessage({
                    type: 'reasoningDelta',
                    messageId: this.currentMessageId,
                    reasoningId: event.data.reasoningId,
                    deltaContent: event.data.deltaContent
                });
                break;

            case 'assistant.reasoning':
                // Complete reasoning - send the summary content
                this.webview.postMessage({
                    type: 'reasoningComplete',
                    messageId: this.currentMessageId,
                    reasoningId: event.data.reasoningId,
                    content: event.data.content
                });
                break;

            case 'session.error':
                // Session error - notify user and end generation
                console.error('[CopilotService] Session error:', event.data.message);
                this.webview.postMessage({
                    type: 'error',
                    message: event.data.message || 'An error occurred during AI processing'
                });
                // Also end generation so UI doesn't hang
                this.webview.postMessage({
                    type: 'generationComplete'
                });
                this.currentMessageId = null;
                break;
        }
    }

    /**
     * Checks if a tool is an internal SDK tool that shouldn't be displayed
     */
    private isInternalTool(toolName: string): boolean {
        const internalTools = ['report_intent', 'suggest_mode'];
        return internalTools.includes(toolName);
    }

    /**
     * Creates a ToolEvent with human-readable label and details
     */
    private createToolEvent(data: any, status: 'loading' | 'success' | 'error'): any {
        const toolCallId = data.toolCallId || `tool_${Date.now()}`;
        const toolName = data.toolName || 'unknown';
        const args = data.arguments || {};
        const result = data.result || {};

        let label = toolName;
        let details: string | undefined;

        switch (toolName) {
            case 'view':
            case 'read_file':
            case 'view_file': {
                const viewPath = this.extractFilePath(args);
                label = status === 'loading'
                    ? `Reading ${this.getFileName(viewPath)}`
                    : `Read ${this.getFileName(viewPath)}`;
                if (result.content) {
                    const lineCount = (result.content.match(/\n/g) || []).length + 1;
                    details = `${lineCount} lines`;
                }
                break;
            }

            case 'write_file':
            case 'write_to_file':
            case 'create_file': {
                const isCreate = toolName === 'create_file' || toolName === 'write_to_file';
                const writePath = this.extractFilePath(args);
                label = status === 'loading'
                    ? `${isCreate ? 'Creating' : 'Writing'} ${this.getFileName(writePath)}`
                    : `${isCreate ? 'Create' : 'Write'} ${this.getFileName(writePath)}`;
                if (args.content) {
                    const lineCount = (args.content.match(/\n/g) || []).length + 1;
                    details = `(+${lineCount})`;
                }
                break;
            }

            case 'edit':
            case 'edit_file':
            case 'replace_file_content':
            case 'multi_replace_file_content': {
                const editPath = this.extractFilePath(args);
                label = status === 'loading'
                    ? `Editing ${this.getFileName(editPath)}`
                    : `Edit ${this.getFileName(editPath)}`;
                if (result.linesAdded !== undefined || result.linesRemoved !== undefined) {
                    const added = result.linesAdded || 0;
                    const removed = result.linesRemoved || 0;
                    if (removed > 0) {
                        details = `(+${added} -${removed})`;
                    } else if (added > 0) {
                        details = `(+${added})`;
                    }
                }
                break;
            }

            case 'run_command':
            case 'execute_command': {
                const cmd = args.command || args.CommandLine || '';
                const truncatedCmd = cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd;
                label = status === 'loading' ? 'Running command' : 'Ran command';
                details = truncatedCmd;
                break;
            }

            case 'grep_search':
            case 'search':
            case 'find_by_name': {
                label = status === 'loading' ? `Searching` : `Searched`;
                const query = args.query || args.pattern || args.Query || args.Pattern || '';
                details = query.length > 30 ? query.substring(0, 30) + '...' : query;
                break;
            }

            case 'list_directory':
            case 'list_dir': {
                const dirPath = this.extractFilePath(args) || args.DirectoryPath || args.directory || args.dir;
                label = status === 'loading'
                    ? `Listing ${this.getFileName(dirPath)}`
                    : `Listed ${this.getFileName(dirPath)}`;
                break;
            }

            case 'web_search':
            case 'search_web':
                label = status === 'loading' ? 'Searching web' : 'Searched web';
                details = args.query;
                break;

            default:
                label = status === 'loading'
                    ? toolName.replace(/_/g, ' ').replace(/^\w/, (c: string) => c.toUpperCase()) + '...'
                    : toolName.replace(/_/g, ' ').replace(/^\w/, (c: string) => c.toUpperCase());
        }

        if (status === 'error' && data.error) {
            details = data.error.message || 'Error occurred';
        }

        return {
            id: `event_${toolCallId}_${Date.now()}`,
            toolCallId,
            toolName,
            status,
            label,
            details,
            timestamp: Date.now()
        };
    }

    /**
     * Extracts file path from various possible argument field names
     */
    private extractFilePath(args: any): string {
        return args.path ||
            args.AbsolutePath ||
            args.TargetFile ||
            args.file ||
            args.filePath ||
            args.File ||
            args.FilePath ||
            '';
    }

    /**
     * Extracts filename from a path
     */
    private getFileName(path: string): string {
        if (!path) return 'file';
        const parts = path.replace(/\\/g, '/').split('/');
        return parts[parts.length - 1] || path;
    }

    /**
     * Sends a message to the AI
     */
    async sendMessage(prompt: string, modelId: string, attachments: FileAttachment[], systemMessage?: string): Promise<void> {
        // Check if we need a new session (no session, or system message changed)
        const systemMessageChanged = this.currentSystemMessage !== systemMessage;
        if (!this.session || systemMessageChanged) {
            await this.createSession(modelId, systemMessage);
        }

        // Generate message ID for tracking
        this.currentMessageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Add assistant message placeholder
        this.webview?.postMessage({
            type: 'addMessage',
            id: this.currentMessageId,
            role: 'assistant',
            content: '',
            model: modelId
        });

        try {
            // Prepare attachments for SDK format
            const sdkAttachments = attachments.map(att => ({
                type: att.type,
                path: att.path,
                displayName: att.name
            }));

            // Send to session
            await this.session.send({
                prompt,
                attachments: sdkAttachments.length > 0 ? sdkAttachments : undefined
            });
        } catch (error) {
            console.error('Failed to send message:', error);
            this.webview?.postMessage({
                type: 'error',
                message: error instanceof Error ? error.message : 'Failed to send message'
            });
        }
    }

    /**
     * Stops the current generation
     */
    async stopGeneration(): Promise<void> {
        try {
            await this.session?.abort();
            console.log('[CopilotService] Generation stopped');
            this.webview?.postMessage({
                type: 'generationComplete'
            });
        } catch (error) {
            console.error('[CopilotService] Failed to stop generation:', error);
        }
    }

    /**
     * Selects a new model
     */
    async selectModel(modelId: string): Promise<void> {
        const { actualModel, autoTier } = this.parseModelSelection(modelId);

        if (this.session) {
            try {
                if (actualModel === 'auto') {
                    if (this.currentModel !== 'auto' && !this.currentModel?.startsWith('auto:')) {
                        if (typeof this.session.setModel === 'function') {
                            await this.session.setModel('auto');
                        }
                    }
                    if (typeof this.session.setAutoTier === 'function') {
                        await this.session.setAutoTier(autoTier);
                    }
                    this.currentModel = modelId;
                    this.webview?.postMessage({
                        type: 'modelChanged',
                        modelId
                    });
                    return;
                } else if (typeof this.session.setModel === 'function') {
                    await this.session.setModel(actualModel);
                    this.currentModel = modelId;
                    this.webview?.postMessage({
                        type: 'modelChanged',
                        modelId
                    });
                    return;
                }
            } catch (err) {
                console.warn('[CopilotService] session.setModel/setAutoTier failed, falling back to recreate session:', err);
            }
        }
        await this.createSession(modelId);
        this.webview?.postMessage({
            type: 'modelChanged',
            modelId
        });
    }

    /**
     * Creates a new session (clears context)
     */
    newSession(): void {
        if (this.session) {
            try {
                if (typeof this.session.disconnect === 'function') {
                    this.session.disconnect();
                } else if (typeof this.session.destroy === 'function') {
                    this.session.destroy();
                }
            } catch {}
        }
        this.session = null;
        this.currentMessageId = null;
    }

    /**
     * Lists all available sessions from the Copilot SDK
     */
    async listSessions(): Promise<any[]> {
        if (!this.client) {
            await this.initialize();
        }

        try {
            if (typeof this.client!.listSessions === 'function') {
                const sessions = await this.client!.listSessions();
                console.log('[CopilotService] Listed sessions:', sessions.length);
                return sessions;
            }
            return [];
        } catch (error) {
            console.error('[CopilotService] Failed to list sessions:', error);
            return [];
        }
    }

    /**
     * Lists all available models from the Copilot SDK and standard Copilot model list
     */
    async listModels(): Promise<ModelOption[]> {
        if (!this.client) {
            await this.initialize();
        }

        try {
            let sdkModels: any[] = [];
            try {
                if (typeof this.client!.listModels === 'function') {
                    sdkModels = await this.client!.listModels();
                }
            } catch (err) {
                console.warn('[CopilotService] client.listModels() failed, will use fallback catalogue:', err);
            }

            console.log('[CopilotService] Listed models from SDK:', sdkModels.length);

            // Complete catalogue of GitHub Copilot models and tiers
            const standardModels: ModelOption[] = [
                // Auto Tiers
                { id: 'auto', name: 'Auto (Default)', multiplier: '', isPremium: false, supportsVision: true, isEnabled: true },
                { id: 'auto:balance', name: 'Auto (Balance)', multiplier: '', isPremium: false, supportsVision: true, isEnabled: true },
                { id: 'auto:intelligence', name: 'Auto (Intelligence)', multiplier: '', isPremium: false, supportsVision: true, isEnabled: true },
                { id: 'auto:efficiency', name: 'Auto (Efficiency)', multiplier: '', isPremium: false, supportsVision: true, isEnabled: true },
                { id: 'auto:fast', name: 'Auto (Fast)', multiplier: '', isPremium: false, supportsVision: true, isEnabled: true },

                // Standard Models
                { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', multiplier: '', isPremium: false, supportsVision: true, isEnabled: true },
                { id: 'gpt-4.1', name: 'GPT-4.1', multiplier: '', isPremium: false, supportsVision: true, isEnabled: true },
                { id: 'gpt-4o', name: 'GPT-4o', multiplier: '', isPremium: false, supportsVision: true, isEnabled: true },
                { id: 'o3-mini', name: 'o3-mini', multiplier: '', isPremium: false, supportsVision: false, isEnabled: true },
                { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', multiplier: '', isPremium: false, supportsVision: true, isEnabled: true },
                { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', multiplier: '', isPremium: false, supportsVision: true, isEnabled: true },

                // Premium / Frontier Models
                { id: 'gpt-5.4', name: 'GPT-5.4', multiplier: '', isPremium: true, supportsVision: true, isEnabled: true },
                { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', multiplier: '', isPremium: true, supportsVision: true, isEnabled: true },
                { id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', multiplier: '', isPremium: true, supportsVision: true, isEnabled: true },
                { id: 'claude-opus-4.6', name: 'Claude Opus 4.6', multiplier: '', isPremium: true, supportsVision: true, isEnabled: true },
                { id: 'claude-opus-4.7', name: 'Claude Opus 4.7', multiplier: '', isPremium: true, supportsVision: true, isEnabled: true },
                { id: 'o1', name: 'o1', multiplier: '', isPremium: true, supportsVision: true, isEnabled: true },
            ];

            const seenIds = new Set<string>();
            const result: ModelOption[] = [];

            // Add SDK reported models first
            for (const model of sdkModels) {
                if (!model || !model.id) continue;
                seenIds.add(model.id);
                result.push({
                    id: model.id,
                    name: model.name || model.id,
                    multiplier: model.billing?.multiplier ? `${model.billing.multiplier}x` : '',
                    isPremium: model.billing?.is_premium ?? false,
                    supportsVision: model.capabilities?.supports?.vision ?? true,
                    isEnabled: model.policy ? model.policy.state === 'enabled' : true,
                    restrictedTo: model.billing?.restricted_to
                });
            }

            // Merge standard models if not already present
            for (const sm of standardModels) {
                if (!seenIds.has(sm.id)) {
                    seenIds.add(sm.id);
                    result.push(sm);
                }
            }

            return result;
        } catch (error) {
            console.error('[CopilotService] Failed to list models:', error);
            throw error;
        }
    }

    /**
     * Resumes an existing session by ID and returns its messages with tool events
     */
    async resumeSession(sessionId: string, _modelId?: string): Promise<ChatMessage[]> {
        if (!this.client) {
            await this.initialize();
        }

        // Close existing session if any
        if (this.session) {
            try {
                if (typeof this.session.disconnect === 'function') {
                    await this.session.disconnect();
                } else if (typeof this.session.destroy === 'function') {
                    await this.session.destroy();
                }
            } catch {}
            this.session = null;
        }

        try {
            this.session = await this.client!.resumeSession(sessionId, {
                streaming: true,
            });
            this.session.on(this.handleEvent.bind(this));
            console.log(`[CopilotService] Resumed session: ${sessionId}`);

            // Load all events from the session
            const events = typeof this.session.getEvents === 'function'
                ? await this.session.getEvents()
                : (typeof this.session.getMessages === 'function' ? await this.session.getMessages() : []);

            const firstEvent = events && events[0];
            const originalModel = firstEvent?.data?.selectedModel;

            // Group events into conversation turns and track model changes
            const turns: ConversationTurn[] = [];
            let currentTurn: ConversationTurn | null = null;
            let currentSessionModel: string | null = originalModel || null;

            for (const event of events) {
                switch (event.type) {
                    case 'session.model_change':
                        currentSessionModel = event.data.newModel;
                        console.log(`[CopilotService] Model changed to: ${currentSessionModel}`);
                        break;

                    case 'user.message':
                        currentTurn = {
                            userMessage: event,
                            assistantMessages: [],
                            toolExecutions: new Map(),
                            activeModel: currentSessionModel
                        };
                        turns.push(currentTurn);
                        break;

                    case 'assistant.message':
                        if (!currentTurn) {
                            currentTurn = {
                                userMessage: null,
                                assistantMessages: [],
                                toolExecutions: new Map(),
                                activeModel: currentSessionModel
                            };
                            turns.push(currentTurn);
                        }
                        currentTurn.assistantMessages.push(event);
                        break;

                    case 'assistant.usage':
                        if (event.data?.model && currentTurn) {
                            currentTurn.activeModel = event.data.model;
                        }
                        break;

                    case 'tool.execution_start':
                        if (currentTurn && !this.isInternalTool(event.data.toolName)) {
                            const toolCallId = event.data.toolCallId;
                            if (!currentTurn.toolExecutions.has(toolCallId)) {
                                currentTurn.toolExecutions.set(toolCallId, {});
                            }
                            currentTurn.toolExecutions.get(toolCallId)!.start = event;
                        }
                        break;

                    case 'tool.execution_complete':
                        if (currentTurn) {
                            const toolCallId = event.data.toolCallId;
                            if (!currentTurn.toolExecutions.has(toolCallId)) {
                                currentTurn.toolExecutions.set(toolCallId, {});
                            }
                            currentTurn.toolExecutions.get(toolCallId)!.complete = event;
                        }
                        break;
                }
            }

            // Build messages with tool events from turns
            const messages: ChatMessage[] = [];
            let lastUsedModel: string | null = null;

            for (const turn of turns) {
                if (turn.userMessage) {
                    messages.push({
                        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        role: 'user',
                        content: turn.userMessage.data?.content || '',
                        timestamp: Date.now()
                    });
                }

                for (const assistantEvent of turn.assistantMessages) {
                    const toolEvents: ToolEvent[] = [];

                    for (const [_toolCallId, execution] of turn.toolExecutions) {
                        if (execution.start) {
                            const completeData = execution.complete ? {
                                ...execution.complete.data,
                                toolName: execution.start.data.toolName,
                                arguments: execution.start.data.arguments
                            } : execution.start.data;

                            const status = execution.complete
                                ? (execution.complete.data.success ? 'success' : 'error')
                                : 'loading';

                            const toolEvent = this.createToolEvent(completeData, status);
                            toolEvents.push(toolEvent);
                        }
                    }

                    const messageModel = turn.activeModel || this.currentModel || undefined;
                    if (messageModel) {
                        lastUsedModel = messageModel;
                    }

                    messages.push({
                        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        role: 'assistant',
                        content: assistantEvent.data?.content || '',
                        timestamp: Date.now(),
                        model: messageModel,
                        toolEvents: toolEvents.length > 0 ? toolEvents : undefined
                    });
                }
            }

            const validMessages = messages.filter(msg => msg.content.trim() !== '');

            if (lastUsedModel) {
                this.currentModel = lastUsedModel;
                if (this.webview) {
                    this.webview.postMessage({
                        type: 'modelChanged',
                        modelId: lastUsedModel
                    });
                }
            }

            console.log(`[CopilotService] Loaded ${validMessages.length} messages with tool events from session (last model: ${lastUsedModel})`);
            return validMessages;
        } catch (error) {
            console.error('[CopilotService] Failed to resume session:', error);
            throw error;
        }
    }

    /**
     * Cleans up resources
     */
    async dispose(): Promise<void> {
        try {
            if (this.session) {
                if (typeof this.session.disconnect === 'function') {
                    await this.session.disconnect();
                } else if (typeof this.session.destroy === 'function') {
                    await this.session.destroy();
                }
            }
            if (this.client) {
                await this.client.stop();
            }
        } catch (error) {
            console.error('Error disposing Copilot service:', error);
        }
    }
}
