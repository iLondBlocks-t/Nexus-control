package com.nexus.phoneagent.policy;

import com.nexus.phoneagent.core.Config;
import com.nexus.phoneagent.util.Redactor;

import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Independent, on-device policy validation.
 *
 * The server screens every plan, and this class screens it again. The phone
 * never executes an action just because a server (or a model) asked for it:
 * unknown types, disabled capabilities, credentials and prompt-injection text
 * found on screen are all refused here.
 */
public final class LocalPolicy {

    /** Action types this build understands. Mirrors the server allowlist. */
    public static final Set<String> ALLOWED_TYPES = new HashSet<>(Arrays.asList(
            "open_app",
            "open_settings",
            "tap_element",
            "scroll",
            "type_text",
            "wait_for_screen",
            "read_visible_ui",
            "back",
            "stop"));

    /** Settings screens the device is willing to open. */
    public static final Set<String> ALLOWED_SETTINGS_TARGETS = new HashSet<>(Arrays.asList(
            "home", "wifi", "bluetooth", "display", "sound", "battery", "applications", "storage",
            "location", "security", "accessibility", "accounts", "date_time", "language",
            "developer", "airplane_mode", "nfc"));

    private static final Set<String> SENSITIVE_LABELS = new HashSet<>(Arrays.asList(
            "send", "post", "publish", "share", "upload", "buy", "purchase", "pay", "payment",
            "checkout", "subscribe", "order", "donate", "transfer", "delete", "uninstall",
            "install", "confirm", "accept", "agree", "place order"));

    private static final Set<String> INJECTION_MARKERS = new HashSet<>(Arrays.asList(
            "ignore previous instructions",
            "ignore all previous instructions",
            "disregard the above",
            "system prompt",
            "new instructions:"));

    private static final int MAX_TEXT_LENGTH = 500;
    private static final int MAX_ACTIONS_HARD_LIMIT = 30;

    private LocalPolicy() {
    }

    /** Outcome of validating one action. */
    public static final class Decision {
        public final boolean allowed;
        public final boolean needsApproval;
        public final String errorCode;
        public final String message;

        private Decision(boolean allowed, boolean needsApproval, String errorCode, String message) {
            this.allowed = allowed;
            this.needsApproval = needsApproval;
            this.errorCode = errorCode;
            this.message = message;
        }

        public static Decision allow() {
            return new Decision(true, false, null, null);
        }

        public static Decision approve(String message) {
            return new Decision(true, true, null, message);
        }

        public static Decision deny(String errorCode, String message) {
            return new Decision(false, false, errorCode, message);
        }
    }

    /**
     * Validate an inbound action.
     *
     * @param action the action payload
     * @param config owner settings (per-action switches and budgets)
     * @param sequence position of the action inside the task
     */
    public static Decision validate(JSONObject action, Config config, int sequence) {
        if (action == null) {
            return Decision.deny("INVALID_REQUEST", "The action was empty.");
        }
        String type = action.optString("type", "");
        if (!ALLOWED_TYPES.contains(type)) {
            return Decision.deny("ACTION_NOT_ALLOWED", "Unsupported action type: " + type);
        }
        if (sequence > MAX_ACTIONS_HARD_LIMIT) {
            return Decision.deny("ACTION_NOT_ALLOWED", "The action budget was exceeded.");
        }
        if (!config.isActionAllowed(type)) {
            return Decision.deny("ACTION_NOT_ALLOWED", "This action is switched off in Settings.");
        }

        switch (type) {
            case "open_app": {
                String packageName = action.optString("package_name", "");
                if (!isPackageName(packageName)) {
                    return Decision.deny("INVALID_REQUEST", "Invalid package identifier.");
                }
                return Decision.allow();
            }
            case "open_settings": {
                String target = action.optString("target", "");
                if (!ALLOWED_SETTINGS_TARGETS.contains(target)) {
                    return Decision.deny("ACTION_NOT_ALLOWED", "Unsupported settings screen: " + target);
                }
                return Decision.allow();
            }
            case "tap_element":
            case "scroll": {
                JSONObject match = action.optJSONObject("match");
                JSONObject target = action.optJSONObject("target");
                String label = labelOf(match != null ? match : target);
                if (containsInjection(label)) {
                    return Decision.deny("ACTION_NOT_ALLOWED", "The label looks like an injected instruction.");
                }
                if (Redactor.isSensitiveFieldLabel(label)) {
                    return Decision.deny("ACTION_NOT_ALLOWED", "NEXUS never interacts with password or card fields.");
                }
                if (isSensitiveLabel(label)) {
                    return Decision.approve("This may send, buy, delete or publish something.");
                }
                return Decision.allow();
            }
            case "type_text": {
                String text = action.optString("text", "");
                if (text.isEmpty() || text.length() > MAX_TEXT_LENGTH) {
                    return Decision.deny("INVALID_REQUEST", "The text to type is empty or too long.");
                }
                String label = labelOf(action.optJSONObject("target"));
                if (containsInjection(label) || containsInjection(text)) {
                    return Decision.deny("ACTION_NOT_ALLOWED", "The text looks like an injected instruction.");
                }
                if (Redactor.looksSensitive(text)) {
                    return Decision.deny("ACTION_NOT_ALLOWED", "NEXUS never types credentials or one-time codes.");
                }
                if (Redactor.isSensitiveFieldLabel(label)) {
                    return Decision.deny("ACTION_NOT_ALLOWED", "NEXUS never types into password or card fields.");
                }
                return Decision.approve("Typing text into the current field.");
            }
            case "wait_for_screen": {
                JSONObject expect = action.optJSONObject("expect");
                if (expect == null || (!expect.has("text") && !expect.has("package_name"))) {
                    return Decision.deny("INVALID_REQUEST", "wait_for_screen needs a text or package expectation.");
                }
                return Decision.allow();
            }
            case "read_visible_ui":
            case "back":
            case "stop":
                return Decision.allow();
            default:
                return Decision.deny("ACTION_NOT_ALLOWED", "Unsupported action type: " + type);
        }
    }

    public static boolean isPackageName(String value) {
        if (value == null || value.length() < 3 || value.length() > 255) {
            return false;
        }
        return value.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+");
    }

    private static String labelOf(JSONObject match) {
        if (match == null) {
            return "";
        }
        String text = match.optString("text", "");
        String description = match.optString("content_description", "");
        return (text + " " + description).trim().toLowerCase();
    }

    private static boolean containsInjection(String value) {
        if (value == null || value.isEmpty()) {
            return false;
        }
        String lower = value.toLowerCase();
        for (String marker : INJECTION_MARKERS) {
            if (lower.contains(marker)) {
                return true;
            }
        }
        return false;
    }

    private static boolean isSensitiveLabel(String value) {
        if (value == null || value.isEmpty()) {
            return false;
        }
        for (String label : SENSITIVE_LABELS) {
            if (value.contains(label)) {
                return true;
            }
        }
        return false;
    }
}
