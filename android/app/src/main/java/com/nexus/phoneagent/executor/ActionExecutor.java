package com.nexus.phoneagent.executor;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Path;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.accessibility.AccessibilityNodeInfo;

import com.nexus.phoneagent.service.NexusAccessibilityService;
import com.nexus.phoneagent.util.Redactor;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Turns one validated action into one real UI interaction.
 *
 * Every executor method returns a Result; none of them throw on failure, so a
 * stuck screen becomes a clean task failure instead of a crash.
 */
public final class ActionExecutor {

    public static final String ERR_ACTION_FAILED = "ACTION_FAILED";
    public static final String ERR_TIMEOUT = "ACTION_TIMEOUT";
    public static final String ERR_APP_NOT_INSTALLED = "APP_NOT_INSTALLED";
    public static final String ERR_TARGET_NOT_FOUND = "TARGET_NOT_FOUND";
    public static final String ERR_TARGET_AMBIGUOUS = "TARGET_AMBIGUOUS";
    public static final String ERR_SCREEN_BLOCKED = "SCREEN_BLOCKED";
    public static final String ERR_NOT_ALLOWED = "ACTION_NOT_ALLOWED";
    public static final String ERR_INVALID = "INVALID_REQUEST";

    private static final int MAX_MATCHES = 3;
    private static final int MAX_TRAVERSED_NODES = 600;
    private static final int MAX_TEXT_NODES = 60;
    private static final long APP_LAUNCH_TIMEOUT_MS = 6000L;
    private static final long DEFAULT_WAIT_MS = 8000L;
    private static final long MAX_WAIT_MS = 15000L;
    private static final long POLL_MS = 250L;
    private static final long AFTER_ACTION_MS = 600L;

    /** Callback used to append lines to the task log. */
    public interface Listener {
        void log(String line);
    }

    public static final class Result {
        public final boolean ok;
        public final String errorCode;
        public final String message;
        public final JSONObject data;

        private Result(boolean ok, String errorCode, String message, JSONObject data) {
            this.ok = ok;
            this.errorCode = errorCode;
            this.message = message;
            this.data = data;
        }

        public static Result success(String message) {
            return new Result(true, null, message, null);
        }

        public static Result success(String message, JSONObject data) {
            return new Result(true, null, message, data);
        }

        public static Result failure(String errorCode, String message) {
            return new Result(false, errorCode, message, null);
        }
    }

    private final NexusAccessibilityService service;
    private final AtomicBoolean stopRequested = new AtomicBoolean(false);
    private volatile Listener listener;

    public ActionExecutor(NexusAccessibilityService service) {
        this.service = service;
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public void requestStop() {
        stopRequested.set(true);
    }

    public void clearStop() {
        stopRequested.set(false);
    }

    private void log(String line) {
        Listener current = listener;
        if (current != null) {
            current.log(line);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Dispatch                                                             */
    /* ------------------------------------------------------------------ */

    public Result execute(JSONObject action) {
        if (action == null) {
            return Result.failure(ERR_INVALID, "The action was empty.");
        }
        String type = action.optString("type", "");
        Result guard = guard();
        if (guard != null) {
            return guard;
        }

        Result result;
        switch (type) {
            case "open_app":
                result = openApp(action);
                break;
            case "open_settings":
                result = openSettings(action);
                break;
            case "tap_element":
                result = tapElement(action);
                break;
            case "scroll":
                result = scroll(action);
                break;
            case "type_text":
                result = typeText(action);
                break;
            case "wait_for_screen":
                result = waitForScreen(action);
                break;
            case "read_visible_ui":
                result = readVisibleUi();
                break;
            case "back":
                result = goBack();
                break;
            case "stop":
                requestStop();
                result = Result.success("Stopped.");
                break;
            default:
                result = Result.failure(ERR_NOT_ALLOWED, "Unsupported action type: " + type);
                break;
        }

        if (result.ok) {
            sleepQuietly(AFTER_ACTION_MS);
        }
        return result;
    }

    private Result guard() {
        if (stopRequested.get()) {
            return Result.failure("TASK_CANCELLED", "The user stopped the task.");
        }
        if (service == null || !NexusAccessibilityService.isEnabled()) {
            return Result.failure("PERMISSION_REQUIRED", "The accessibility service is not enabled.");
        }
        KeyguardManager keyguard = (KeyguardManager) service.getSystemService(Context.KEYGUARD_SERVICE);
        if (keyguard != null && keyguard.isKeyguardLocked()) {
            return Result.failure(ERR_SCREEN_BLOCKED, "The lock screen is showing.");
        }
        if (service.root() == null) {
            return Result.failure(ERR_SCREEN_BLOCKED, "The current screen cannot be read.");
        }
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* Actions                                                              */
    /* ------------------------------------------------------------------ */

    private Result openApp(JSONObject action) {
        String packageName = action.optString("package_name", "");
        if (packageName.isEmpty()) {
            return Result.failure(ERR_INVALID, "No package name was provided.");
        }
        PackageManager manager = service.getPackageManager();
        Intent launch = null;
        try {
            launch = manager.getLaunchIntentForPackage(packageName);
        } catch (Exception ignored) {
            // Treated as "not installed" below.
        }
        if (launch == null) {
            return Result.failure(ERR_APP_NOT_INSTALLED, packageName + " is not installed.");
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        try {
            service.startActivity(launch);
        } catch (Exception e) {
            return Result.failure(ERR_ACTION_FAILED, "Could not open " + packageName + ".");
        }
        log("Opened " + packageName);

        long deadline = System.currentTimeMillis() + APP_LAUNCH_TIMEOUT_MS;
        while (System.currentTimeMillis() < deadline) {
            if (stopRequested.get()) {
                return Result.failure("TASK_CANCELLED", "The user stopped the task.");
            }
            AccessibilityNodeInfo root = service.root();
            if (root != null && packageName.equals(packageOf(root))) {
                return Result.success("Opened " + labelFor(packageName));
            }
            sleepQuietly(POLL_MS);
        }
        return Result.failure(ERR_TIMEOUT, packageName + " did not come to the front.");
    }

    private Result openSettings(JSONObject action) {
        String target = action.optString("target", "");
        if ("home".equals(target)) {
            boolean done = service.performGlobal(AccessibilityService.GLOBAL_ACTION_HOME);
            if (!done) {
                return Result.failure(ERR_ACTION_FAILED, "The home screen could not be opened.");
            }
            log("Went to the home screen");
            return Result.success("Went to the home screen.");
        }
        String intentAction = settingsIntent(target);
        if (intentAction == null) {
            return Result.failure(ERR_NOT_ALLOWED, "Unsupported settings screen: " + target);
        }
        Intent intent = new Intent(intentAction);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            service.startActivity(intent);
        } catch (Exception e) {
            return Result.failure(ERR_ACTION_FAILED, "Could not open the " + target + " settings.");
        }
        log("Opened settings: " + target);
        return Result.success("Opened the " + target.replace('_', ' ') + " settings.");
    }

    private static String settingsIntent(String target) {
        switch (target) {
            case "wifi":
                return Settings.ACTION_WIFI_SETTINGS;
            case "bluetooth":
                return Settings.ACTION_BLUETOOTH_SETTINGS;
            case "display":
                return Settings.ACTION_DISPLAY_SETTINGS;
            case "sound":
                return Settings.ACTION_SOUND_SETTINGS;
            case "battery":
                return Build.VERSION.SDK_INT >= 21 ? Settings.ACTION_BATTERY_SAVER_SETTINGS : Settings.ACTION_SETTINGS;
            case "applications":
                return Settings.ACTION_APPLICATION_SETTINGS;
            case "storage":
                return Settings.ACTION_INTERNAL_STORAGE_SETTINGS;
            case "location":
                return Settings.ACTION_LOCATION_SOURCE_SETTINGS;
            case "security":
                return Settings.ACTION_SECURITY_SETTINGS;
            case "accessibility":
                return Settings.ACTION_ACCESSIBILITY_SETTINGS;
            case "accounts":
                return Settings.ACTION_SYNC_SETTINGS;
            case "date_time":
                return Settings.ACTION_DATE_SETTINGS;
            case "language":
                return Settings.ACTION_LOCALE_SETTINGS;
            case "developer":
                return Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS;
            case "airplane_mode":
                return Settings.ACTION_AIRPLANE_MODE_SETTINGS;
            case "nfc":
                return Build.VERSION.SDK_INT >= 16 ? Settings.ACTION_NFC_SETTINGS : Settings.ACTION_SETTINGS;
            default:
                return null;
        }
    }

    private Result tapElement(JSONObject action) {
        JSONObject match = action.optJSONObject("match");
        if (match == null) {
            match = action.optJSONObject("target");
        }
        if (match == null || !hasCriteria(match)) {
            return Result.failure(ERR_INVALID, "tap_element needs a match description.");
        }
        AccessibilityNodeInfo root = service.root();
        List<AccessibilityNodeInfo> matches = find(root, match);
        if (matches.isEmpty()) {
            return Result.failure(ERR_TARGET_NOT_FOUND, "No element matched " + describe(match) + ".");
        }
        if (matches.size() > MAX_MATCHES && !match.has("index")) {
            release(matches);
            return Result.failure(ERR_TARGET_AMBIGUOUS,
                    matches.size() + " elements matched " + describe(match) + ".");
        }
        int index = Math.max(0, Math.min(match.optInt("index", 0), matches.size() - 1));
        AccessibilityNodeInfo node = matches.get(index);
        for (int i = 0; i < matches.size(); i += 1) {
            if (i != index) {
                matches.get(i).recycle();
            }
        }

        if (node.isPassword()) {
            node.recycle();
            return Result.failure(ERR_NOT_ALLOWED, "NEXUS does not interact with password fields.");
        }

        AccessibilityNodeInfo clickable = clickableAncestor(node);
        boolean clicked = false;
        if (clickable != null) {
            try {
                clicked = clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            } catch (SecurityException ignored) {
                clicked = false;
            }
        }
        String label = describe(match);
        if (!clicked) {
            // Fall back to a gesture on the element's own bounds.
            android.graphics.Rect bounds = new android.graphics.Rect();
            node.getBoundsInScreen(bounds);
            if (clickable != null && clickable != node) {
                clickable.recycle();
            }
            node.recycle();
            if (bounds.width() > 0 && bounds.height() > 0 && tapAt(bounds.centerX(), bounds.centerY())) {
                log("Tapped " + label);
                return Result.success("Tapped " + label + ".");
            }
            return Result.failure(ERR_ACTION_FAILED, "The element could not be tapped.");
        }
        if (clickable != node) {
            clickable.recycle();
        }
        node.recycle();
        log("Tapped " + label);
        return Result.success("Tapped " + label + ".");
    }

    private Result scroll(JSONObject action) {
        String direction = action.optString("direction", "down").toLowerCase(Locale.US);
        boolean forward = !"up".equals(direction) && !"left".equals(direction);

        AccessibilityNodeInfo root = service.root();
        AccessibilityNodeInfo target = null;
        JSONObject match = action.optJSONObject("target");
        if (match != null && hasCriteria(match)) {
            List<AccessibilityNodeInfo> matches = find(root, match);
            if (!matches.isEmpty()) {
                target = scrollableAncestor(matches.get(0));
                release(matches);
            }
        }
        if (target == null) {
            target = firstScrollable(root);
        }

        if (target != null) {
            int actionId = forward
                    ? AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
                    : AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD;
            boolean scrolled = false;
            try {
                scrolled = target.performAction(actionId);
            } catch (SecurityException ignored) {
                scrolled = false;
            }
            if (scrolled) {
                target.recycle();
                log("Scrolled " + direction);
                return Result.success("Scrolled " + direction + ".");
            }
            target.recycle();
        }

        if (Build.VERSION.SDK_INT >= 24 && swipe(direction)) {
            log("Swiped " + direction);
            return Result.success("Scrolled " + direction + ".");
        }
        return Result.failure(ERR_ACTION_FAILED, "This screen cannot be scrolled.");
    }

    private Result typeText(JSONObject action) {
        String text = action.optString("text", "");
        if (text.isEmpty()) {
            return Result.failure(ERR_INVALID, "No text was provided.");
        }
        AccessibilityNodeInfo root = service.root();
        AccessibilityNodeInfo field = null;

        JSONObject match = action.optJSONObject("target");
        if (match != null && hasCriteria(match)) {
            List<AccessibilityNodeInfo> matches = find(root, match);
            if (matches.isEmpty()) {
                return Result.failure(ERR_TARGET_NOT_FOUND, "No input field matched " + describe(match) + ".");
            }
            field = matches.get(0);
            for (int i = 1; i < matches.size(); i += 1) {
                matches.get(i).recycle();
            }
        } else {
            field = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        }

        if (field == null) {
            return Result.failure(ERR_TARGET_NOT_FOUND, "No focused input field was found.");
        }
        if (field.isPassword()) {
            field.recycle();
            return Result.failure(ERR_NOT_ALLOWED, "NEXUS does not type into password fields.");
        }

        boolean editable = field.isEditable();
        if (!editable) {
            field.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            sleepQuietly(150L);
            AccessibilityNodeInfo focused = service.root() == null ? null
                    : service.root().findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focused != null && focused.isEditable()) {
                field.recycle();
                field = focused;
                editable = true;
            }
        }
        if (!editable) {
            field.recycle();
            return Result.failure(ERR_ACTION_FAILED, "That element does not accept text.");
        }

        Bundle arguments = new Bundle();
        arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean typed = false;
        try {
            typed = field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
        } catch (SecurityException ignored) {
            typed = false;
        }
        field.recycle();
        if (!typed) {
            return Result.failure(ERR_ACTION_FAILED, "The text could not be entered.");
        }
        log("Typed " + text.length() + " characters");
        return Result.success("Typed " + text.length() + " characters.");
    }

    private Result waitForScreen(JSONObject action) {
        JSONObject expect = action.optJSONObject("expect");
        if (expect == null) {
            return Result.failure(ERR_INVALID, "wait_for_screen needs an expectation.");
        }
        String text = expect.optString("text", "");
        String packageName = expect.optString("package_name", "");
        long timeout = Math.min(action.optLong("timeout_ms", DEFAULT_WAIT_MS), MAX_WAIT_MS);
        long deadline = System.currentTimeMillis() + timeout;

        while (System.currentTimeMillis() < deadline) {
            if (stopRequested.get()) {
                return Result.failure("TASK_CANCELLED", "The user stopped the task.");
            }
            AccessibilityNodeInfo root = service.root();
            if (root != null) {
                if (!packageName.isEmpty() && packageName.equals(packageOf(root))) {
                    return Result.success("The expected screen is showing.");
                }
                if (!text.isEmpty() && containsText(root, text)) {
                    return Result.success("The expected screen is showing.");
                }
            }
            sleepQuietly(POLL_MS);
        }
        return Result.failure(ERR_TIMEOUT, "The expected screen did not appear.");
    }

    private Result readVisibleUi() {
        JSONObject data = readScreen();
        if (data == null) {
            return Result.failure(ERR_SCREEN_BLOCKED, "The current screen cannot be read.");
        }
        int nodes = data.optJSONArray("nodes") != null ? data.optJSONArray("nodes").length() : 0;
        return Result.success("Read " + nodes + " visible elements.", data);
    }

    private Result goBack() {
        boolean done = service.performGlobal(AccessibilityService.GLOBAL_ACTION_BACK);
        if (!done) {
            return Result.failure(ERR_ACTION_FAILED, "The back action was refused.");
        }
        log("Pressed back");
        return Result.success("Went back.");
    }

    /* ------------------------------------------------------------------ */
    /* Screen reading                                                       */
    /* ------------------------------------------------------------------ */

    /** Snapshot of the visible screen, used as planning context. */
    public JSONObject readScreen() {
        AccessibilityNodeInfo root = service.root();
        if (root == null) {
            return null;
        }
        JSONObject screen = new JSONObject();
        JSONArray nodes = new JSONArray();
        int[] counter = {0};
        int[] emitted = {0};
        boolean[] truncated = {false};

        Deque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(AccessibilityNodeInfo.obtain(root));
        while (!queue.isEmpty() && counter[0] < MAX_TRAVERSED_NODES) {
            AccessibilityNodeInfo node = queue.poll();
            if (node == null) {
                continue;
            }
            counter[0] += 1;
            String text = safeString(node.getText());
            String description = safeString(node.getContentDescription());
            if (node.isPassword()) {
                if (!text.isEmpty()) {
                    text = Redactor.PLACEHOLDER;
                }
                if (!description.isEmpty()) {
                    description = Redactor.PLACEHOLDER;
                }
            }
            boolean interesting = !text.isEmpty() || !description.isEmpty()
                    || node.isClickable() || node.isEditable() || node.isScrollable();
            if (interesting && emitted[0] < MAX_TEXT_NODES) {
                String safeText = Redactor.redact(text);
                String safeDescription = Redactor.redact(description);
                if (!safeText.isEmpty() || !safeDescription.isEmpty() || node.isClickable() || node.isScrollable()) {
                    JSONObject item = new JSONObject();
                    try {
                        if (!safeText.isEmpty()) {
                            item.put("text", safeText);
                        }
                        if (!safeDescription.isEmpty()) {
                            item.put("content_description", safeDescription);
                        }
                        item.put("view_id", shortId(safeString(node.getViewIdResourceName())));
                        item.put("clickable", node.isClickable());
                        item.put("editable", node.isEditable());
                        item.put("scrollable", node.isScrollable());
                        item.put("focused", node.isFocused());
                    } catch (org.json.JSONException ignored) {
                        // Constant keys; cannot fail.
                    }
                    nodes.put(item);
                    emitted[0] += 1;
                }
            } else if (interesting) {
                truncated[0] = true;
            }

            int children = node.getChildCount();
            for (int i = 0; i < children && counter[0] < MAX_TRAVERSED_NODES; i += 1) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) {
                    queue.add(child);
                }
            }
            node.recycle();
        }
        while (!queue.isEmpty()) {
            AccessibilityNodeInfo leftover = queue.poll();
            if (leftover != null) {
                leftover.recycle();
            }
        }

        try {
            screen.put("package", packageOf(root));
            screen.put("nodes", nodes);
            screen.put("truncated", truncated[0]);
        } catch (org.json.JSONException ignored) {
            // Constant keys; cannot fail.
        }
        return screen;
    }

    /* ------------------------------------------------------------------ */
    /* Node helpers                                                         */
    /* ------------------------------------------------------------------ */

    private static boolean hasCriteria(JSONObject match) {
        return match.has("text") || match.has("content_description") || match.has("view_id")
                || match.has("class_name") || match.has("resource_id");
    }

    static String describe(JSONObject match) {
        String text = match.optString("text", "");
        if (!text.isEmpty()) {
            return "\"" + text + "\"";
        }
        String description = match.optString("content_description", "");
        if (!description.isEmpty()) {
            return "\"" + description + "\"";
        }
        String id = match.optString("view_id", match.optString("resource_id", ""));
        if (!id.isEmpty()) {
            return id;
        }
        return match.optString("class_name", "the element");
    }

    private static List<AccessibilityNodeInfo> find(AccessibilityNodeInfo root, JSONObject match) {
        List<AccessibilityNodeInfo> matches = new ArrayList<>();
        if (root == null) {
            return matches;
        }
        String text = match.optString("text", "");
        String description = match.optString("content_description", "");
        String viewId = match.optString("view_id", match.optString("resource_id", ""));
        String className = match.optString("class_name", "");
        boolean contains = match.optBoolean("contains", false);

        Deque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(AccessibilityNodeInfo.obtain(root));
        int visited = 0;
        while (!queue.isEmpty() && visited < MAX_TRAVERSED_NODES) {
            AccessibilityNodeInfo node = queue.poll();
            if (node == null) {
                continue;
            }
            visited += 1;
            if (nodeMatches(node, text, description, viewId, className, contains)) {
                matches.add(node);
            } else {
                int children = node.getChildCount();
                for (int i = 0; i < children; i += 1) {
                    AccessibilityNodeInfo child = node.getChild(i);
                    if (child != null) {
                        queue.add(child);
                    }
                }
                node.recycle();
            }
        }
        while (!queue.isEmpty()) {
            AccessibilityNodeInfo leftover = queue.poll();
            if (leftover != null) {
                leftover.recycle();
            }
        }
        return matches;
    }

    private static boolean nodeMatches(AccessibilityNodeInfo node, String text, String description,
                                       String viewId, String className, boolean contains) {
        if (!text.isEmpty()) {
            String value = safeString(node.getText()).toLowerCase(Locale.US);
            String wanted = text.toLowerCase(Locale.US);
            if (!(contains ? value.contains(wanted) : value.equals(wanted))) {
                return false;
            }
        }
        if (!description.isEmpty()) {
            String value = safeString(node.getContentDescription()).toLowerCase(Locale.US);
            String wanted = description.toLowerCase(Locale.US);
            if (!(contains ? value.contains(wanted) : value.equals(wanted))) {
                return false;
            }
        }
        if (!viewId.isEmpty()) {
            String value = shortId(safeString(node.getViewIdResourceName()));
            if (!(contains ? value.contains(viewId) : value.equals(viewId))) {
                return false;
            }
        }
        if (!className.isEmpty()) {
            String value = safeString(node.getClassName());
            if (!(contains ? value.contains(className) : value.equals(className))) {
                return false;
            }
        }
        return true;
    }

    private static boolean containsText(AccessibilityNodeInfo root, String wanted) {
        List<AccessibilityNodeInfo> matches = find(root, singleTextMatch(wanted));
        boolean found = !matches.isEmpty();
        release(matches);
        return found;
    }

    /** Builds a match object that looks for a substring of any visible text. */
    static JSONObject singleTextMatch(String text) {
        JSONObject match = new JSONObject();
        try {
            match.put("text", text);
            match.put("contains", true);
        } catch (org.json.JSONException ignored) {
            // Constant keys; cannot fail.
        }
        return match;
    }

    private static AccessibilityNodeInfo clickableAncestor(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node;
        for (int depth = 0; depth < 6 && current != null; depth += 1) {
            if (current.isClickable() && !current.isPassword()) {
                return current;
            }
            AccessibilityNodeInfo parent = current.getParent();
            if (parent == null) {
                return current;
            }
            if (current != node) {
                current.recycle();
            }
            current = parent;
        }
        return current;
    }

    private static AccessibilityNodeInfo scrollableAncestor(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node;
        for (int depth = 0; depth < 6 && current != null; depth += 1) {
            if (current.isScrollable()) {
                return current;
            }
            AccessibilityNodeInfo parent = current.getParent();
            if (parent == null) {
                break;
            }
            if (current != node) {
                current.recycle();
            }
            current = parent;
        }
        return current;
    }

    private static AccessibilityNodeInfo firstScrollable(AccessibilityNodeInfo root) {
        if (root == null) {
            return null;
        }
        Deque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(AccessibilityNodeInfo.obtain(root));
        AccessibilityNodeInfo found = null;
        int visited = 0;
        while (!queue.isEmpty() && visited < MAX_TRAVERSED_NODES) {
            AccessibilityNodeInfo node = queue.poll();
            if (node == null) {
                continue;
            }
            visited += 1;
            if (node.isScrollable()) {
                found = node;
                break;
            }
            int children = node.getChildCount();
            for (int i = 0; i < children; i += 1) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) {
                    queue.add(child);
                }
            }
            node.recycle();
        }
        while (!queue.isEmpty()) {
            AccessibilityNodeInfo leftover = queue.poll();
            if (leftover != null) {
                leftover.recycle();
            }
        }
        return found;
    }

    private static void release(List<AccessibilityNodeInfo> nodes) {
        for (AccessibilityNodeInfo node : nodes) {
            node.recycle();
        }
        nodes.clear();
    }

    private static String packageOf(AccessibilityNodeInfo node) {
        CharSequence name = node.getPackageName();
        return name == null ? "" : name.toString();
    }

    private static String safeString(CharSequence value) {
        return value == null ? "" : value.toString().trim();
    }

    private static String shortId(String id) {
        if (id == null || id.isEmpty()) {
            return "";
        }
        int slash = id.indexOf('/');
        return slash >= 0 && slash + 1 < id.length() ? id.substring(slash + 1) : id;
    }

    private static String labelFor(String packageName) {
        try {
            PackageManager manager = NexusAccessibilityService.instance().getPackageManager();
            android.content.pm.ApplicationInfo info = manager.getApplicationInfo(packageName, 0);
            CharSequence label = manager.getApplicationLabel(info);
            if (label != null && !label.toString().isEmpty()) {
                return label.toString();
            }
        } catch (Exception ignored) {
            // Fall back to the package name.
        }
        return packageName;
    }

    /* ------------------------------------------------------------------ */
    /* Gestures                                                             */
    /* ------------------------------------------------------------------ */

    private boolean tapAt(int x, int y) {
        if (Build.VERSION.SDK_INT < 24) {
            return false;
        }
        Path path = new Path();
        path.moveTo(x, y);
        final boolean[] done = {false};
        final Object lock = new Object();
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 60L))
                .build();
        service.dispatchGesture(gesture, new AccessibilityService.GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription description) {
                done[0] = true;
                synchronized (lock) {
                    lock.notifyAll();
                }
            }

            @Override
            public void onCancelled(GestureDescription description) {
                synchronized (lock) {
                    lock.notifyAll();
                }
            }
        }, null);
        synchronized (lock) {
            try {
                lock.wait(2000L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        return done[0];
    }

    private boolean swipe(String direction) {
        android.graphics.Point size = new android.graphics.Point();
        android.view.WindowManager window = (android.view.WindowManager)
                service.getSystemService(Context.WINDOW_SERVICE);
        if (window == null) {
            return false;
        }
        android.view.Display display = window.getDefaultDisplay();
        if (display == null) {
            return false;
        }
        display.getSize(size);
        int width = size.x > 0 ? size.x : 720;
        int height = size.y > 0 ? size.y : 1280;
        int centerX = width / 2;
        int centerY = height / 2;

        int startX = centerX;
        int startY = centerY;
        int endX = centerX;
        int endY = centerY;
        switch (direction) {
            case "up":
                startY = (int) (height * 0.75);
                endY = (int) (height * 0.25);
                break;
            case "left":
                startX = (int) (width * 0.80);
                endX = (int) (width * 0.20);
                break;
            case "right":
                startX = (int) (width * 0.20);
                endX = (int) (width * 0.80);
                break;
            default:
                startY = (int) (height * 0.75);
                endY = (int) (height * 0.25);
                break;
        }

        Path path = new Path();
        path.moveTo(startX, startY);
        path.lineTo(endX, endY);
        final boolean[] done = {false};
        final Object lock = new Object();
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 350L))
                .build();
        service.dispatchGesture(gesture, new AccessibilityService.GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription description) {
                done[0] = true;
                synchronized (lock) {
                    lock.notifyAll();
                }
            }

            @Override
            public void onCancelled(GestureDescription description) {
                synchronized (lock) {
                    lock.notifyAll();
                }
            }
        }, null);
        synchronized (lock) {
            try {
                lock.wait(2500L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        return done[0];
    }

    private void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
