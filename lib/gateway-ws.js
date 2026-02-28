/**
 * Gateway WebSocket Manager
 * Maintains a persistent connection to the OpenClaw Gateway
 * 
 * Issue: #111 - WebSocket manager class for persistent connection
 * Parent: #110 - Persistent WebSocket connection for real-time events
 */

const EventEmitter = require('events');
const WebSocket = require('ws');

class GatewayWsManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.wsUrl = options.wsUrl || process.env.GATEWAY_WS_URL || 'ws://openclaw.llm.svc.cluster.local:18789';
        this.clientId = options.clientId || 'miso-chat';
        this.clientVersion = options.clientVersion || 'miso-chat/1.0.0';
        this.clientMode = options.clientMode || 'ui';
        this.headers = options.headers || {};
        
        this.ws = null;
        this.connected = false;
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
        this.reconnectDelay = options.reconnectDelay || 1000;
        this.reconnectBackoff = options.reconnectBackoff || 2;
        
        // Store origin for reconnection
        this._lastOrigin = options.origin || 'http://localhost:3000';
        
        this.pendingRequests = new Map();
        this.requestIdCounter = 0;
    }

    /**
     * Generate a unique request ID
     */
    createRequestId(prefix = 'req') {
        return `${prefix}-${Date.now()}-${++this.requestIdCounter}`;
    }

    /**
     * Connect to the Gateway WebSocket
     */
    connect(origin = 'http://localhost:3000') {
        return new Promise((resolve, reject) => {
            if (this.connected) {
                return resolve(true);
            }
            
            if (this.connecting) {
                // Wait for existing connection attempt
                this.once('connected', () => resolve(true));
                this.once('error', (err) => reject(err));
                return;
            }

            this.connecting = true;
            
            const headers = {
                ...this.headers,
                origin: origin,
            };

            this.ws = new WebSocket(this.wsUrl, { headers });

            this.ws.on('open', () => {
                this.connected = true;
                this.connecting = false;
                this.reconnectAttempts = 0;
                // Update stored origin for future reconnections
                this._lastOrigin = origin;
                this.emit('connected');
                resolve(true);
            });

            this.ws.on('close', (code, reason) => {
                const wasConnected = this.connected;
                this.connected = false;
                this.connecting = false;
                this.emit('close', code, reason);
                
                if (wasConnected) {
                    this._attemptReconnect(this._lastOrigin);
                }
            });

            this.ws.on('error', (error) => {
                this.connecting = false;
                this.emit('error', error);
                reject(error);
            });

            this.ws.on('message', (data) => {
                try {
                    const frame = JSON.parse(data.toString());
                    this._handleFrame(frame);
                } catch (err) {
                    this.emit('parse-error', err, data);
                }
            });
        });
    }

    /**
     * Handle incoming WebSocket frames
     */
    _handleFrame(frame) {
        // Handle response to a pending request
        if (frame.id && this.pendingRequests.has(frame.id)) {
            const { resolve, reject, timeout } = this.pendingRequests.get(frame.id);
            clearTimeout(timeout);
            this.pendingRequests.delete(frame.id);
            
            if (frame.error) {
                reject(new Error(frame.error.message || frame.error));
            } else {
                resolve(frame);
            }
            return;
        }

        // Emit event for other frames
        this.emit('frame', frame);
        
        if (frame.type === 'event') {
            this.emit('gateway-event', frame.event, frame.data);
        }
    }

    /**
     * Attempt to reconnect with exponential backoff
     */
    _attemptReconnect(origin) {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.emit('reconnect-failed', new Error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached. Gateway may be down or network issues.`));
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(this.reconnectBackoff, this.reconnectAttempts - 1);
        
        this.emit('reconnecting', this.reconnectAttempts, delay);
        
        setTimeout(() => {
            this.connect(origin).catch((err) => {
                this.emit('reconnect-error', err);
            });
        }, delay);
    }

    /**
     * Send a request and wait for response
     */
    send(method, params = {}, timeoutSeconds = 30) {
        return new Promise((resolve, reject) => {
            if (!this.connected) {
                return reject(new Error(`WebSocket not connected. Method: ${method}. Is the Gateway accessible at ${this.wsUrl}?`));
            }

            const id = this.createRequestId(`req-${method}`);
            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request ${method} (${id}) timed out after ${timeoutSeconds}s - Gateway may be overloaded or unreachable`));
                }
            }, timeoutSeconds * 1000);

            this.pendingRequests.set(id, { resolve, reject, timeout });

            this.ws.send(JSON.stringify({
                type: 'req',
                id,
                method,
                params,
            }));
        });
    }

    /**
     * Send a message frame without waiting for response
     */
    sendFrame(frame) {
        return new Promise((resolve, reject) => {
            if (!this.connected) {
                return reject(new Error(`Cannot send frame: WebSocket not connected. Frame type: ${frame.type || 'unknown'}`));
            }

            this.ws.send(JSON.stringify(frame), (err) => {
                if (err) reject(err);
                else resolve(true);
            });
        });
    }

    /**
     * Disconnect from the Gateway
     */
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this.connecting = false;
        this.pendingRequests.clear();
    }

    /**
     * Check if currently connected
     */
    isConnected() {
        return this.connected;
    }
}

module.exports = { GatewayWsManager };
