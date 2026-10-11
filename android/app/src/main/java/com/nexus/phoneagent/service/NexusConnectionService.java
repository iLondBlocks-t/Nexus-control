package com.nexus.phoneagent.service;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.IBinder;

import com.nexus.phoneagent.R;
import com.nexus.phoneagent.core.Config;
import com.nexus.phoneagent.core.SecureStore;
import com.nexus.phoneagent.data.TaskStore;
import com.nexus.phoneagent.executor.ActionExecutor;
import com.nexus.phoneagent.model.ActionRecord;
import com.nexus.phoneagent.model.ConnectionState;
import com.nexus.phoneagent.model.TaskRecord;
import com.nexus.phoneagent.net.WebSocketClient;
import com.nexus.phoneagent.policy.LocalPolicy;
import com.nexus.phoneagent.protocol.Protocol;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URI;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The long lived, owner-visible connection to the NEXUS server.
 *
 * It owns the WebSocket, the heartbeat, the retry and backoff policy, the
 * sequence bookkeeping that makes replay impossible, and the single active task
 * at a time. It never executes a UI action itself: that is the accessibility
 * service's job, through the executor.
 */
public class NexusConnectionService extends Service implements WebSocketClient.Listener {

    public static final String ACTION_START = "com.nexus.phoneagent.action.START";
    public static final String ACTION_STOP = "com.nexus.phoneagent.action.STOP";
    public static final String ACTION_STOP_TASK = "com.nexus.phoneagent.action.STOP_TASK";
    public static final String ACTION_SUBMIT_TASK = "com.nexus.phoneagent.action.SUBMIT_TASK";
    public static final String ACTION_DECIDE_TASK = "com.nexus.phoneagent.action.DECIDE_TASK";
    public static final String ACTION_SUBMIT_RESULT = "com.nexus.phoneagent.SUBMIT_RESULT";
    public static final String ACTION_STATE_CHANGED = "com.nexus.phoneagent.STATE_CHANGED";
    public static final String ACTION_TASK_UPDATE = "com.nexus.phoneagent.TASK_UPDATE";
    public static final String ACTION_APPROVAL_REQUIRED = "com.nexus.phoneagent.APPROVAL_REQUIRED";
    public static final String EXTRA_STATE = "state";
    public static final String EXTRA_TASK_ID = "task_id";
    public static final String EXTRA_MESSAGE = "message";
    public static final String EXTRA_INSTRUCTION = "instruction";
    public static final String EXTRA_ERROR_CODE = "error_code";
    public static final String EXTRA_REQUEST_ID = "request_id";
    public static final String EXTRA_APPROVED = "approved";

    private static final int NOTIFICATION_ID = 4271;
    private static final String CHANNEL_ID = "nexus_connection";
    private static final long[] BACKOFF_MS = {2000L, 4000L, 8000L, 15000L, 30000L, 60000L};
    private static final long HEARTBEAT_INTERVAL_MS = 20000L;
    private static final long HEARTBEAT_TIMEOUT_MS = 90000L;
    private static final int MAX_MESSAGE_BYTES = 64 * 1024;
    private static final int MAX_ELEMENTS = 50;

    private static volatile ConnectionState state = ConnectionState.NOT_CONFIGURED;
    private static volatile String lastError = "";
    private static volatile long lastHeartbeatAt = 0L;
    private static volatile String activeTaskId = "";

    public static ConnectionState getState() {
        return state;
    }

    public static String getLastError() {
        return lastError;
    }

    public static long getLastHeartbeatAt() {
        return lastHeartbeatAt;
    }

    public static String getActiveTaskId() {
        return activeTaskId;
    }

    public static boolean isConnected() {
        return state == ConnectionState.CONNECTED;
    }

    private final ConcurrentHashMap<String, TaskContext> tasks = new ConcurrentHashMap<>();
    private final AtomicBoolean stopping = new AtomicBoolean(false);
    private final AtomicBoolean loopRunning = new AtomicBoolean(false);

    private Config config;
    private SecureStore store;
    private TaskStore taskStore;
    private NotificationManager notifications;

    private ExecutorService connectionExecutor;
    private ExecutorService messageExecutor;
    private ExecutorService actionExecutor;
    private ScheduledExecutorService heartbeatExecutor;

    private volatile WebSocketClient client;
    private volatile CountDownLatch closedLatch;
    private volatile int reconnectAttempt = 0;
    private volatile boolean lastAccessibilityState = false;

    /** Per task bookkeeping: sequence numbers, deadline and the last result. */
    private static final class TaskContext {
        final String taskId;
        final String instruction;
        final long startedAt;
        final long deadlineMs;
        int lastSequence;
        String lastActionId;
        JSONObject lastResult;
        boolean cancelled;
        TaskRecord record;

        TaskContext(String taskId, String instruction, long startedAt, long deadlineMs) {
            this.taskId = taskId;
            this.instruction = instruction;
            this.startedAt = startedAt;
            this.deadlineMs = deadlineMs;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        config = new Config(this);
        store = new SecureStore(this);
        taskStore = TaskStore.get(this);
        notifications = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        createChannel();

        connectionExecutor = Executors.newSingleThreadExecutor();
        messageExecutor = Executors.newSingleThreadExecutor();
        actionExecutor = Executors.newSingleThreadExecutor();
        heartbeatExecutor = Executors.newSingleThreadScheduledExecutor();
        heartbeatExecutor.scheduleWithFixedDelay(this::heartbeatTick,
                HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;

        if (ACTION_STOP.equals(action)) {
            stopEverything();
            return START_NOT_STICKY;
        }
        if (ACTION_SUBMIT_TASK.equals(action)) {
            String instruction = intent.getStringExtra(EXTRA_INSTRUCTION);
            submitTask(instruction);
            return START_STICKY;
        }
        if (ACTION_DECIDE_TASK.equals(action)) {
            final String taskId = intent.getStringExtra(EXTRA_TASK_ID);
            final boolean approved = intent.getBooleanExtra(EXTRA_APPROVED, false);
            if (taskId != null && !taskId.isEmpty()) {
                sendTaskDecision(taskId, approved);
            }
            return START_STICKY;
        }
        if (ACTION_STOP_TASK.equals(action)) {
            String taskId = intent.getStringExtra(EXTRA_TASK_ID);
            final String toStop = taskId == null || taskId.isEmpty() ? activeTaskId : taskId;
            if (!toStop.isEmpty()) {
                messageExecutor.execute(() -> cancelTask(toStop, "user_cancelled"));
            }
            return START_STICKY;
        }

        startForeground(NOTIFICATION_ID, buildNotification());

        if (!config.isConfigured()) {
            setState(ConnectionState.NOT_CONFIGURED, "Set your server address first.");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!store.hasCredentials()) {
            setState(ConnectionState.WAITING_FOR_PAIRING, "Pair this phone from the setup screen.");
            stopSelf();
            return START_NOT_STICKY;
        }

        stopping.set(false);
        startConnectionLoop();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopEverything();
        connectionExecutor.shutdownNow();
        messageExecutor.shutdownNow();
        actionExecutor.shutdownNow();
        heartbeatExecutor.shutdownNow();
        super.onDestroy();
    }

    private void stopEverything() {
        stopping.set(true);
        closeClient(1000, "stopped");
        setState(ConnectionState.DISCONNECTED, null);
        stopForeground(true);
    }

    /* ------------------------------------------------------------------ */
    /* Connection loop                                                      */
    /* ------------------------------------------------------------------ */

    private void startConnectionLoop() {
        if (loopRunning.compareAndSet(false, true)) {
            connectionExecutor.execute(this::connectionLoop);
        }
    }

    private void connectionLoop() {
        while (!stopping.get()) {
            if (!config.isConfigured() || !store.hasCredentials()) {
                break;
            }
            setState(ConnectionState.CONNECTING, null);

            String endpoint = config.deriveWebSocketUrl();
            if (endpoint.isEmpty()) {
                setState(ConnectionState.DISCONNECTED, "The server address is not usable.");
                break;
            }

            CountDownLatch latch = new CountDownLatch(1);
            closedLatch = latch;
            try {
                WebSocketClient socket = new WebSocketClient(URI.create(endpoint), this,
                        10000, (int) HEARTBEAT_TIMEOUT_MS, MAX_MESSAGE_BYTES);
                client = socket;
                socket.connect();
                latch.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                setState(ConnectionState.DISCONNECTED, cleanMessage(e.getMessage()));
            } finally {
                closeClientQuietly();
            }

            if (stopping.get()) {
                break;
            }
            if (state == ConnectionState.AUTH_FAILED || state == ConnectionState.REVOKED) {
                // Credential problems must not be retried in a tight loop: the
                // owner has to pair again.
                break;
            }
            if (!config.isAutoReconnectEnabled()) {
                setState(ConnectionState.DISCONNECTED, null);
                break;
            }

            int attempt = Math.min(reconnectAttempt, BACKOFF_MS.length - 1);
            reconnectAttempt += 1;
            setState(ConnectionState.RECONNECTING, null);
            sleepQuietly(BACKOFF_MS[attempt] + (long) (Math.random() * 1000L));
        }
        loopRunning.set(false);
        if (state != ConnectionState.AUTH_FAILED && state != ConnectionState.REVOKED) {
            setState(ConnectionState.DISCONNECTED, lastError);
        }
    }

    private void closeClient(int code, String reason) {
        WebSocketClient socket = client;
        if (socket != null) {
            socket.close(code, reason);
        }
        CountDownLatch latch = closedLatch;
        if (latch != null) {
            latch.countDown();
        }
    }

    private void closeClientQuietly() {
        WebSocketClient socket = client;
        client = null;
        if (socket != null) {
            try {
                socket.close(1000, "closed");
            } catch (Exception ignored) {
                // Nothing else to do while tearing down.
            }
        }
        CountDownLatch latch = closedLatch;
        if (latch != null) {
            latch.countDown();
        }
    }

    /* ------------------------------------------------------------------ */
    /* WebSocketClient.Listener                                             */
    /* ------------------------------------------------------------------ */

    @Override
    public void onOpen() {
        try {
            JSONObject clientInfo = new JSONObject();
            clientInfo.put("app_version", appVersion());
            clientInfo.put("android_version", Build.VERSION.RELEASE);
            clientInfo.put("device_model", Build.MANUFACTURER + " " + Build.MODEL);
            clientInfo.put("accessibility_enabled", NexusAccessibilityService.isEnabled());

            JSONObject hello = Protocol.deviceHello(
                    config.getDeviceId(), store.getDeviceToken(), clientInfo);
            send(hello);
        } catch (org.json.JSONException e) {
            setState(ConnectionState.DISCONNECTED, "Could not build the handshake.");
        }
    }

    @Override
    public void onTextMessage(String text) {
        final String payload = text;
        messageExecutor.execute(() -> handleMessage(payload));
    }

    @Override
    public void onClosed(int code, String reason) {
        lastHeartbeatAt = 0L;
        if (state == ConnectionState.CONNECTED) {
            setState(ConnectionState.RECONNECTING, null);
        }
        CountDownLatch latch = closedLatch;
        if (latch != null) {
            latch.countDown();
        }
    }

    @Override
    public void onError(String message, Throwable cause) {
        lastHeartbeatAt = 0L;
        setState(ConnectionState.SERVER_UNAVAILABLE, cleanMessage(message));
        CountDownLatch latch = closedLatch;
        if (latch != null) {
            latch.countDown();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Heartbeat                                                            */
    /* ------------------------------------------------------------------ */

    private void heartbeatTick() {
        if (stopping.get()) {
            return;
        }
        WebSocketClient socket = client;
        if (socket == null || !socket.isOpen()) {
            return;
        }
        if (state != ConnectionState.CONNECTED) {
            return;
        }
        long since = System.currentTimeMillis() - lastHeartbeatAt;
        if (lastHeartbeatAt > 0L && since > HEARTBEAT_TIMEOUT_MS) {
            // The server stopped answering: drop the socket and let the loop retry.
            closeClient(1001, "heartbeat timeout");
            return;
        }

        boolean accessibility = NexusAccessibilityService.isEnabled();
        if (accessibility != lastAccessibilityState) {
            lastAccessibilityState = accessibility;
            try {
                send(Protocol.deviceStatus(accessibility, batteryPercent(), isCharging()));
            } catch (org.json.JSONException ignored) {
                // Optional status update.
            }
        }

        try {
            send(Protocol.heartbeat());
        } catch (org.json.JSONException ignored) {
            // Cannot happen: the heartbeat has no dynamic content.
        }
    }

    private int batteryPercent() {
        Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (battery == null) {
            return -1;
        }
        int level = battery.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1);
        int scale = battery.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1);
        if (level < 0 || scale <= 0) {
            return -1;
        }
        return (int) (level * 100L / scale);
    }

    private boolean isCharging() {
        Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (battery == null) {
            return false;
        }
        int status = battery.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1);
        return status == android.os.BatteryManager.BATTERY_STATUS_CHARGING
                || status == android.os.BatteryManager.BATTERY_STATUS_FULL;
    }

    /* ------------------------------------------------------------------ */
    /* Message handling                                                     */
    /* ------------------------------------------------------------------ */

    private void handleMessage(String text) {
        Protocol.Inbound inbound = Protocol.parse(text);
        if (!inbound.isValid()) {
            sendProtocolError(inbound.errorCode, inbound.errorMessage, null);
            return;
        }

        JSONObject message = inbound.json;
        String messageId = message.optString("message_id", null);

        switch (inbound.type) {
            case Protocol.TYPE_AUTH_OK:
                onAuthOk(message);
                break;
            case Protocol.TYPE_AUTH_FAILED:
                onAuthFailed(message);
                break;
            case Protocol.TYPE_HEARTBEAT_ACK:
                lastHeartbeatAt = System.currentTimeMillis();
                break;
            case Protocol.TYPE_TASK_DISPATCH:
                onTaskDispatch(message);
                break;
            case Protocol.TYPE_EXECUTE_ACTION:
                final JSONObject dispatch = message;
                actionExecutor.execute(() -> runAction(dispatch));
                break;
            case Protocol.TYPE_CANCEL_TASK:
                cancelTask(message.optString("task_id", ""), message.optString("reason", "user_cancelled"));
                break;
            case Protocol.TYPE_APPROVAL_REQUIRED:
                onApprovalRequired(message);
                break;
            case Protocol.TYPE_TASK_COMPLETED:
                onTaskCompleted(message);
                break;
            case Protocol.TYPE_TASK_ACCEPTED:
                onTaskAccepted(message);
                break;
            case Protocol.TYPE_TASK_REJECTED:
                onTaskRejected(message);
                break;
            case Protocol.TYPE_APPROVAL_RESULT:
                onApprovalResult(message);
                break;
            case Protocol.TYPE_DEVICE_REVOKED:
                onDeviceRevoked(message);
                break;
            case Protocol.TYPE_PROTOCOL_ERROR:
                lastError = message.optString("message", "The server reported a protocol error.");
                broadcastState();
                break;
            default:
                sendProtocolError("INVALID_REQUEST", "Unhandled message type.", messageId);
                break;
        }
    }

    private void onAuthOk(JSONObject message) {
        reconnectAttempt = 0;
        lastHeartbeatAt = System.currentTimeMillis();
        setState(ConnectionState.CONNECTED, null);
        lastAccessibilityState = NexusAccessibilityService.isEnabled();
        try {
            send(Protocol.deviceStatus(lastAccessibilityState, batteryPercent(), isCharging()));
        } catch (org.json.JSONException ignored) {
            // Optional status update.
        }
        updateNotification();
    }

    private void onAuthFailed(JSONObject message) {
        String code = message.optString("error_code", "AUTHENTICATION_REQUIRED");
        String messageText = message.optString("message", "The server rejected this device.");
        if ("DEVICE_REVOKED".equals(code) || "INVALID_PROTOCOL_VERSION".equals(code)) {
            store.clear();
            config.setPaired(false);
            setState(ConnectionState.REVOKED, messageText);
        } else {
            setState(ConnectionState.AUTH_FAILED, messageText);
        }
        closeClient(1008, code);
        updateNotification();
    }

    private void onTaskDispatch(JSONObject message) {
        String taskId = message.optString("task_id", "");
        String instruction = message.optString("instruction", "");
        int actionCount = Math.max(1, message.optInt("action_count", 1));

        if (!activeTaskId.isEmpty() && !activeTaskId.equals(taskId)) {
            sendProtocolError("DEVICE_BUSY", "Another task is already running on this device.", null);
            return;
        }
        if (NexusAccessibilityService.instance() == null) {
            sendProtocolError("ACCESSIBILITY_NOT_ENABLED",
                    "The accessibility service is not enabled on this device.", null);
            return;
        }

        long now = System.currentTimeMillis();
        long deadline = now + (config.getMaxDurationSeconds() * 1000L);
        TaskContext context = new TaskContext(taskId, instruction, now, deadline);
        TaskRecord record = new TaskRecord(taskId, instruction, now, actionCount);
        context.record = record;
        tasks.put(taskId, context);
        taskStore.add(record);
        activeTaskId = taskId;

        ActionExecutor executor = NexusAccessibilityService.instance().executor();
        if (executor != null) {
            executor.clearStop();
            executor.setListener(line -> appendLog(taskId, line));
        }

        try {
            send(Protocol.taskProgress(taskId, "running", "Accepted the task."));
        } catch (org.json.JSONException ignored) {
            // Not fatal.
        }
        updateNotification();
        broadcastTask(taskId);
    }

    private void onApprovalRequired(JSONObject message) {
        String taskId = message.optString("task_id", "");
        TaskContext context = tasks.get(taskId);
        if (context != null && context.record != null) {
            context.record.status = "awaiting_approval";
            context.record.approvalState = "pending";
            taskStore.add(context.record);
        }

        String reasons = Protocol.approvalReasons(message);
        Intent intent = new Intent(ACTION_APPROVAL_REQUIRED);
        intent.putExtra(EXTRA_TASK_ID, taskId);
        intent.putExtra(EXTRA_MESSAGE, reasons);
        intent.setPackage(getPackageName());
        sendBroadcast(intent);

        Notification.Builder builder = notificationBuilder()
                .setContentTitle(getString(R.string.task_approval_title))
                .setContentText(reasons)
                .setStyle(new Notification.BigTextStyle().bigText(reasons));
        notifications.notify(NOTIFICATION_ID + 1, builder.build());
        broadcastTask(taskId);
    }

    private void onTaskCompleted(JSONObject message) {
        String taskId = message.optString("task_id", "");
        TaskContext context = tasks.remove(taskId);
        if (context != null && context.record != null) {
            context.record.status = message.optString("status", "completed");
            context.record.endedAt = System.currentTimeMillis();
            context.record.resultSummary = message.optString("summary", null);
            context.record.errorCode = message.optString("error_code", null);
            taskStore.add(context.record);
        }
        notifications.cancel(NOTIFICATION_ID + 1);
        if (taskId.equals(activeTaskId)) {
            activeTaskId = "";
        }
        ActionExecutor executor = executorOrNull();
        if (executor != null) {
            executor.clearStop();
        }
        updateNotification();
        broadcastTask(taskId);
    }

    private void onDeviceRevoked(JSONObject message) {
        store.clear();
        config.setPaired(false);
        setState(ConnectionState.REVOKED, message.optString("reason", "This device was revoked."));
        activeTaskId = "";
        closeClient(1008, "device_revoked");
        updateNotification();
    }

    /**
     * Ask the server to plan and run an instruction the owner typed on the phone.
     *
     * The phone holds no owner API token, so the request travels over the
     * device's own authenticated socket and is validated, rate limited and
     * planned by the server exactly like an API task.
     *
     * @return the request id, or null when the phone is not connected.
     */
    public String submitTask(String instruction) {
        if (instruction == null || instruction.trim().isEmpty()) {
            return null;
        }
        WebSocketClient socket = client;
        if (socket == null || !socket.isOpen() || state != ConnectionState.CONNECTED) {
            broadcastSubmitResult("", "", "DEVICE_OFFLINE",
                    "The phone is not connected to your server.");
            return null;
        }
        String requestId = "req_" + System.currentTimeMillis();
        try {
            if (!socket.send(Protocol.taskCreate(requestId, instruction).toString())) {
                broadcastSubmitResult(requestId, "", "DEVICE_OFFLINE",
                        "The task could not be sent.");
                return null;
            }
        } catch (org.json.JSONException e) {
            broadcastSubmitResult(requestId, "", "INVALID_REQUEST", "The instruction was rejected.");
            return null;
        }
        return requestId;
    }

    private void onTaskAccepted(JSONObject message) {
        String taskId = message.optString("task_id", "");
        broadcastSubmitResult(message.optString("request_id", ""), taskId, null, null);
    }

    private void onTaskRejected(JSONObject message) {
        broadcastSubmitResult(message.optString("request_id", ""), "",
                message.optString("error_code", "INVALID_REQUEST"),
                message.optString("message", "The server refused this task."));
    }

    /** Send the owner's approve/deny decision for a parked task. */
    private void sendTaskDecision(String taskId, boolean approved) {
        try {
            send(Protocol.taskDecision(approved, taskId));
        } catch (org.json.JSONException ignored) {
            // Constant keys; cannot fail.
        }
    }

    private void onApprovalResult(JSONObject message) {
        String taskId = message.optString("task_id", "");
        String errorCode = message.optString("error_code", "");
        TaskContext context = tasks.get(taskId);
        if (context != null && context.record != null) {
            context.record.approvalState = errorCode.isEmpty()
                    ? (message.optBoolean("approved", false) ? "approved" : "denied")
                    : "error";
            context.record.status = message.optString("status", context.record.status);
            taskStore.add(context.record);
        }
        if (!errorCode.isEmpty()) {
            lastError = message.optString("message", "The decision was refused.");
        }
        notifications.cancel(NOTIFICATION_ID + 1);
        broadcastTask(taskId);
    }

    private void broadcastSubmitResult(String requestId, String taskId, String errorCode, String message) {
        Intent intent = new Intent(ACTION_SUBMIT_RESULT);
        intent.putExtra(EXTRA_REQUEST_ID, requestId);
        intent.putExtra(EXTRA_TASK_ID, taskId);
        intent.putExtra(EXTRA_ERROR_CODE, errorCode == null ? "" : errorCode);
        intent.putExtra(EXTRA_MESSAGE, message == null ? "" : message);
        intent.setPackage(getPackageName());
        sendBroadcast(intent);
    }

    /* ------------------------------------------------------------------ */
    /* Action execution                                                     */
    /* ------------------------------------------------------------------ */

    private void runAction(JSONObject message) {
        String taskId = message.optString("task_id", "");
        String actionId = message.optString("action_id", "");
        int sequence = message.optInt("sequence", 0);
        JSONObject action = message.optJSONObject("action");
        String messageId = message.optString("message_id", null);

        TaskContext context = tasks.get(taskId);
        if (context == null) {
            // The dispatch was missed (for example right after a reconnect):
            // rebuild enough state to answer honestly instead of crashing.
            context = new TaskContext(taskId, "", System.currentTimeMillis(),
                    System.currentTimeMillis() + (config.getMaxDurationSeconds() * 1000L));
            context.record = new TaskRecord(taskId, "", System.currentTimeMillis(), sequence);
            tasks.put(taskId, context);
        }

        // Replay protection: an identical message id is answered from cache, an
        // old sequence is refused, and a gap means we missed an action.
        if (actionId.equals(context.lastActionId) && context.lastResult != null) {
            sendCached(context.lastResult);
            return;
        }
        if (sequence < context.lastSequence) {
            sendProtocolError("STALE_SEQUENCE", "Sequence " + sequence + " was already handled.", messageId);
            return;
        }
        if (sequence > context.lastSequence + 1) {
            sendProtocolError("SEQUENCE_GAP", "Expected sequence " + (context.lastSequence + 1) + ".", messageId);
            return;
        }

        ActionRecord record = new ActionRecord(actionId, sequence, action.optString("type", ""),
                summaryFor(action));

        if (isExpired(message.optString("expires_at", "")) || System.currentTimeMillis() > context.deadlineMs) {
            finishAction(context, record, sequence, false, "TASK_CANCELLED",
                    "The task expired before this action ran.", 0L, null);
            return;
        }

        LocalPolicy.Decision decision = LocalPolicy.validate(action, config.toPolicySettings(), sequence);
        if (!decision.allowed) {
            finishAction(context, record, sequence, false, decision.errorCode, decision.message, 0L, null);
            return;
        }
        if (decision.needsApproval) {
            appendLog(taskId, "Sensitive action; it only runs after the server confirms approval.");
        }

        ActionExecutor executor = executorOrNull();
        if (executor == null) {
            finishAction(context, record, sequence, false, "ACCESSIBILITY_NOT_ENABLED",
                    "The accessibility service is not enabled.", 0L, null);
            return;
        }

        ActionExecutor.Result result;
        long startedAt = System.currentTimeMillis();
        try {
            result = executor.execute(action);
        } catch (Throwable error) {
            result = ActionExecutor.Result.failure("INTERNAL_ERROR",
                    error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        long duration = System.currentTimeMillis() - startedAt;

        finishAction(context, record, sequence, result.ok, result.errorCode, result.message,
                duration, buildResultPayload(action, result));
    }

    private void finishAction(TaskContext context, ActionRecord record, int sequence, boolean ok,
                              String errorCode, String message, long durationMs, JSONObject result) {
        record.status = ok ? "succeeded" : "failed";
        record.errorCode = ok ? null : mapErrorCode(errorCode);
        record.message = message;
        record.durationMs = durationMs;

        if (ok) {
            context.lastSequence = sequence;
        } else {
            // A failed action keeps its sequence so the server can retry it
            // with a fresh action id.
            context.lastSequence = Math.max(context.lastSequence, sequence);
        }
        context.lastActionId = record.actionId;

        try {
            JSONObject payload = Protocol.actionResult(context.taskId, record.actionId, sequence, ok,
                    record.errorCode, message, durationMs, result);
            context.lastResult = payload;
            send(payload);
        } catch (org.json.JSONException e) {
            // Cannot happen: all keys are constant literals.
        }

        TaskRecord taskRecord = context.record;
        if (taskRecord != null) {
            boolean replaced = false;
            for (int i = 0; i < taskRecord.actions.size(); i += 1) {
                if (taskRecord.actions.get(i).actionId.equals(record.actionId)) {
                    taskRecord.actions.set(i, record);
                    replaced = true;
                    break;
                }
            }
            if (!replaced) {
                taskRecord.actions.add(record);
            }
            taskStore.add(taskRecord);
        }
        broadcastTask(context.taskId);
    }

    private void sendCached(JSONObject payload) {
        WebSocketClient socket = client;
        if (socket != null && socket.isOpen()) {
            socket.send(payload.toString());
        }
    }

    private void cancelTask(String taskId, String reason) {
        TaskContext context = tasks.get(taskId);
        if (context == null) {
            return;
        }
        context.cancelled = true;
        ActionExecutor executor = executorOrNull();
        if (executor != null) {
            executor.requestStop();
            // Cleared after the action that is currently running finishes, so
            // the stop only cancels this task.
            final ActionExecutor target = executor;
            actionExecutor.execute(target::clearStop);
        }
        appendLog(taskId, "Cancelled (" + reason + ").");
        if (taskId.equals(activeTaskId)) {
            activeTaskId = "";
        }
        updateNotification();
        broadcastTask(taskId);
    }

    /* ------------------------------------------------------------------ */
    /* Payload helpers                                                      */
    /* ------------------------------------------------------------------ */

    private JSONObject buildResultPayload(JSONObject action, ActionExecutor.Result result) {
        JSONObject payload = new JSONObject();
        String type = action.optString("type", "");
        try {
            if ("read_visible_ui".equals(type) && result.data != null) {
                JSONArray nodes = result.data.optJSONArray("nodes");
                JSONArray elements = new JSONArray();
                JSONArray visibleText = new JSONArray();
                if (nodes != null) {
                    for (int i = 0; i < nodes.length() && elements.length() < MAX_ELEMENTS; i += 1) {
                        JSONObject node = nodes.optJSONObject(i);
                        if (node == null) {
                            continue;
                        }
                        JSONObject element = new JSONObject();
                        String text = node.optString("text", "");
                        String description = node.optString("content_description", "");
                        if (!text.isEmpty()) {
                            element.put("text", text);
                            visibleText.put(text);
                        }
                        if (!description.isEmpty()) {
                            element.put("content_description", description);
                        }
                        element.put("clickable", node.optBoolean("clickable", false));
                        elements.put(element);
                    }
                }
                payload.put("summary", result.message);
                payload.put("package_name", result.data.optString("package", ""));
                payload.put("elements", elements);
                payload.put("visible_text", visibleText);
                return payload;
            }

            payload.put("summary", result.message);
            if ("open_app".equals(type) || "open_settings".equals(type)) {
                payload.put("package_name", action.optString("package_name", ""));
            }
            if ("tap_element".equals(type)) {
                payload.put("matched", result.ok);
            }
            if ("scroll".equals(type)) {
                payload.put("scrolled", result.ok);
            }
        } catch (org.json.JSONException ignored) {
            // Constant keys; cannot fail.
        }
        return payload;
    }

    /** Maps an executor error onto the error codes the protocol allows. */
    private static String mapErrorCode(String code) {
        if (code == null) {
            return "INTERNAL_ERROR";
        }
        switch (code) {
            case "ACTION_TIMEOUT":
            case "APP_NOT_INSTALLED":
            case "TARGET_AMBIGUOUS":
            case "TARGET_NOT_FOUND":
            case "ACCESSIBILITY_NOT_ENABLED":
            case "ACTION_NOT_ALLOWED":
            case "SCREEN_BLOCKED":
            case "TASK_CANCELLED":
            case "INVALID_REQUEST":
            case "INTERNAL_ERROR":
                return code;
            case "PERMISSION_REQUIRED":
                return "ACCESSIBILITY_NOT_ENABLED";
            default:
                return "INTERNAL_ERROR";
        }
    }

    private static String summaryFor(JSONObject action) {
        if (action == null) {
            return "Unknown action";
        }
        String type = action.optString("type", "unknown");
        switch (type) {
            case "open_app":
                return "Open " + action.optString("package_name", "app");
            case "open_settings":
                return "Open " + action.optString("target", "settings").replace('_', ' ') + " settings";
            case "tap_element": {
                JSONObject match = action.optJSONObject("match");
                return "Tap " + (match == null ? "element"
                        : match.optString("text", match.optString("content_description", "element")));
            }
            case "scroll":
                return "Scroll " + action.optString("direction", "down");
            case "type_text":
                return "Type " + action.optString("text", "").length() + " characters";
            case "wait_for_screen": {
                JSONObject expect = action.optJSONObject("expect");
                return "Wait for " + (expect == null ? "the next screen"
                        : expect.optString("text", expect.optString("package_name", "the next screen")));
            }
            case "read_visible_ui":
                return "Read the visible screen";
            case "back":
                return "Go back";
            case "stop":
                return "Stop";
            default:
                return type;
        }
    }

    private static boolean isExpired(String isoTime) {
        if (isoTime == null || isoTime.isEmpty()) {
            return false;
        }
        long expires = parseIso(isoTime);
        return expires > 0L && System.currentTimeMillis() > expires;
    }

    private static long parseIso(String value) {
        String[] patterns = {"yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'",
                "yyyy-MM-dd'T'HH:mm:ssZ", "yyyy-MM-dd'T'HH:mm:ss.SSSZ"};
        for (String pattern : patterns) {
            try {
                SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
                return format.parse(value).getTime();
            } catch (ParseException | IllegalArgumentException ignored) {
                // Try the next pattern.
            }
        }
        return 0L;
    }

    private void appendLog(String taskId, String line) {
        TaskContext context = tasks.get(taskId);
        if (context == null || context.record == null) {
            return;
        }
        String current = context.record.resultSummary == null ? "" : context.record.resultSummary;
        String next = (current + "\n" + line).trim();
        context.record.resultSummary = next.length() > 2000 ? next.substring(next.length() - 2000) : next;
    }

    /* ------------------------------------------------------------------ */
    /* Sending, state and notifications                                     */
    /* ------------------------------------------------------------------ */

    private void send(JSONObject message) {
        WebSocketClient socket = client;
        if (socket != null && socket.isOpen()) {
            socket.send(message.toString());
        }
    }

    private void sendProtocolError(String errorCode, String message, String refMessageId) {
        try {
            send(Protocol.protocolError(errorCode, message, refMessageId));
        } catch (org.json.JSONException ignored) {
            // Constant keys; cannot fail.
        }
    }

    private void setState(ConnectionState next, String error) {
        state = next;
        lastError = error == null ? "" : error;
        broadcastState();
        updateNotification();
    }

    private void broadcastState() {
        Intent intent = new Intent(ACTION_STATE_CHANGED);
        intent.putExtra(EXTRA_STATE, state.name());
        intent.putExtra(EXTRA_MESSAGE, lastError);
        intent.setPackage(getPackageName());
        sendBroadcast(intent);
    }

    private void broadcastTask(String taskId) {
        Intent intent = new Intent(ACTION_TASK_UPDATE);
        intent.putExtra(EXTRA_TASK_ID, taskId);
        intent.setPackage(getPackageName());
        sendBroadcast(intent);
    }

    private String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0.1.0";
        }
    }

    private ActionExecutor executorOrNull() {
        NexusAccessibilityService service = NexusAccessibilityService.instance();
        return service == null ? null : service.executor();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26 || notifications == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                getString(R.string.notification_channel_name), NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(R.string.notification_channel_description));
        channel.setShowBadge(false);
        notifications.createNotificationChannel(channel);
    }

    private Notification.Builder notificationBuilder() {
        Intent openIntent = new Intent(this, com.nexus.phoneagent.ui.MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 1, openIntent,
                pendingIntentFlags());

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_stat_nexus)
                .setContentTitle(getString(R.string.app_full_name))
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE);
        return builder;
    }

    private static int pendingIntentFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return flags;
    }

    private Notification buildNotification() {
        return updateBuilder(notificationBuilder()).build();
    }

    private void updateNotification() {
        if (notifications == null) {
            return;
        }
        try {
            notifications.notify(NOTIFICATION_ID, updateBuilder(notificationBuilder()).build());
        } catch (Exception ignored) {
            // Notifications are best effort; the state is still broadcast.
        }
    }

    private Notification.Builder updateBuilder(Notification.Builder builder) {
        String text;
        if (!activeTaskId.isEmpty()) {
            text = getString(R.string.notification_task_running);
            Intent stopIntent = new Intent(this, NexusConnectionService.class);
            stopIntent.setAction(ACTION_STOP_TASK);
            stopIntent.putExtra(EXTRA_TASK_ID, activeTaskId);
            PendingIntent stopPending = PendingIntent.getService(this, 2, stopIntent,
                    pendingIntentFlags());
            builder.addAction(android.R.drawable.ic_media_pause,
                    getString(R.string.notification_action_stop), stopPending);
        } else {
            switch (state) {
                case CONNECTED:
                    text = getString(R.string.notification_connected);
                    break;
                case CONNECTING:
                case RECONNECTING:
                    text = getString(R.string.notification_connecting);
                    break;
                default:
                    text = getString(R.string.notification_disconnected);
                    break;
            }
        }
        builder.setContentText(text);
        builder.setStyle(new Notification.BigTextStyle().bigText(text));
        return builder;
    }

    private static String cleanMessage(String message) {
        if (message == null) {
            return "";
        }
        return message.length() > 200 ? message.substring(0, 200) : message;
    }

    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Removes every finished task older than the retention window. */
    public void pruneHistory() {
        taskStore.prune(config.getRetentionDays());
    }

    /** Small helper used by the UI to know whether anything is still running. */
    public boolean hasActiveTasks() {
        return !activeTaskId.isEmpty();
    }
}
