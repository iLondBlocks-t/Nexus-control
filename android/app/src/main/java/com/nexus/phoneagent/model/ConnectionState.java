package com.nexus.phoneagent.model;

/**
 * Every connection state the dashboard can display.
 *
 * The UI shows "Connected" only after the server accepted the device credential
 * on an authenticated WebSocket session.
 */
public enum ConnectionState {
    NOT_CONFIGURED,
    WAITING_FOR_PAIRING,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    DISCONNECTED,
    AUTH_FAILED,
    ACCESSIBILITY_REQUIRED,
    SERVER_UNAVAILABLE,
    REVOKED;

    public boolean isConnected() {
        return this == CONNECTED;
    }

    /** True while the client may still be trying to reach the server. */
    public boolean isTransient() {
        return this == CONNECTING || this == RECONNECTING;
    }
}
