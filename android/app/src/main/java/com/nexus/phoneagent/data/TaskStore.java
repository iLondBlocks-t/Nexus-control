package com.nexus.phoneagent.data;

import android.content.Context;

import com.nexus.phoneagent.model.TaskRecord;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Local task history.
 *
 * Plain JSON in the app's private files directory: no content provider, no
 * backup, no cloud sync. Records older than the configured retention are
 * dropped on every write, and the file is capped so a busy device cannot fill
 * its storage.
 */
public final class TaskStore {

    private static final String FILE_NAME = "nexus_tasks.json";
    private static final int MAX_RECORDS = 200;
    private static final long DAY_MILLIS = 24L * 60L * 60L * 1000L;

    private static volatile TaskStore instance;

    private final File file;
    private final List<TaskRecord> records = new ArrayList<>();

    public static synchronized TaskStore get(Context context) {
        if (instance == null) {
            instance = new TaskStore(context.getApplicationContext());
        }
        return instance;
    }

    private TaskStore(Context context) {
        this.file = new File(context.getFilesDir(), FILE_NAME);
        load();
    }

    private synchronized void load() {
        records.clear();
        if (!file.exists()) {
            return;
        }
        try {
            String content = read(file);
            JSONArray array = new JSONArray(content);
            for (int i = 0; i < array.length(); i += 1) {
                JSONObject item = array.optJSONObject(i);
                if (item != null) {
                    records.add(TaskRecord.fromJson(item));
                }
            }
        } catch (IOException | JSONException e) {
            // A corrupt history file must never block the app: start clean.
            records.clear();
        }
    }

    public synchronized void add(TaskRecord record) {
        for (int i = 0; i < records.size(); i += 1) {
            if (records.get(i).taskId.equals(record.taskId)) {
                records.set(i, record);
                persist();
                return;
            }
        }
        records.add(0, record);
        persist();
    }

    public synchronized TaskRecord get(String taskId) {
        for (TaskRecord record : records) {
            if (record.taskId.equals(taskId)) {
                return record;
            }
        }
        return null;
    }

    public synchronized List<TaskRecord> all() {
        return Collections.unmodifiableList(new ArrayList<>(records));
    }

    public synchronized void prune(int retentionDays) {
        if (retentionDays <= 0) {
            return;
        }
        long cutoff = System.currentTimeMillis() - (retentionDays * DAY_MILLIS);
        List<TaskRecord> kept = new ArrayList<>();
        for (TaskRecord record : records) {
            if (record.startedAt >= cutoff) {
                kept.add(record);
            }
        }
        if (kept.size() != records.size()) {
            records.clear();
            records.addAll(kept);
            persist();
        }
    }

    public synchronized void clear() {
        records.clear();
        persist();
    }

    private synchronized void persist() {
        while (records.size() > MAX_RECORDS) {
            records.remove(records.size() - 1);
        }
        JSONArray array = new JSONArray();
        for (TaskRecord record : records) {
            array.put(record.toJson());
        }
        try {
            byte[] bytes = array.toString().getBytes(StandardCharsets.UTF_8);
            File temp = new File(file.getParentFile(), FILE_NAME + ".tmp");
            try (FileOutputStream stream = new FileOutputStream(temp)) {
                stream.write(bytes);
                stream.flush();
                stream.getFD().sync();
            }
            if (!temp.renameTo(file)) {
                throw new IOException("Could not replace " + file.getName());
            }
        } catch (IOException e) {
            // Losing the history is acceptable; crashing the agent is not.
        }
    }

    private static String read(File source) throws IOException {
        try (FileInputStream stream = new FileInputStream(source)) {
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = stream.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
