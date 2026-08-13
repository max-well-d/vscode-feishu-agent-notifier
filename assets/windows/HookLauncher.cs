using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;

public static class HookLauncher
{
    private const int MaxPendingEvents = 100;

    public static int Main(string[] argv)
    {
        try
        {
            var args = ParseArguments(argv);
            string raw = FindJsonArgument(args.Positional);
            if (String.IsNullOrWhiteSpace(raw))
                raw = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)).ReadToEnd();
            raw = raw.Trim();
            if (!raw.StartsWith("{") || !raw.EndsWith("}"))
                throw new InvalidOperationException("通知脚本没有收到有效的 JSON 对象");

            string eventJson = AddMetadata(raw, Value(args, "source", "unknown"));
            try
            {
                PostEvent(eventJson, ParsePort(Value(args, "port", "37561")), ReadToken(args));
            }
            catch (Exception deliveryError)
            {
                bool queueOffline = Value(args, "queue-offline", "true") != "false";
                if (!queueOffline || !QueueOffline(eventJson, deliveryError, Value(args, "spool", "")))
                    TryWriteError("[agent-link] " + deliveryError.Message);
            }
            TryWriteOutput("{}\n");
            return 0;
        }
        catch (Exception error)
        {
            TryWriteError("[agent-link] " + error.Message);
            TryWriteOutput("{}\n");
            return 0;
        }
    }

    private static void PostEvent(string eventJson, int port, string token)
    {
        byte[] body = new UTF8Encoding(false).GetBytes(eventJson);
        var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/event");
        request.Method = "POST";
        request.ContentType = "application/json; charset=utf-8";
        request.ContentLength = body.Length;
        request.Timeout = 5000;
        request.ReadWriteTimeout = 5000;
        request.Headers["X-Feishu-Agent-Token"] = token;
        using (Stream stream = request.GetRequestStream())
            stream.Write(body, 0, body.Length);
        using (var response = (HttpWebResponse)request.GetResponse())
        {
            int status = (int)response.StatusCode;
            if (status < 200 || status >= 300)
                throw new InvalidOperationException("本地通知接收器返回 HTTP " + status);
        }
    }

    private static bool QueueOffline(string eventJson, Exception error, string directory)
    {
        if (String.IsNullOrWhiteSpace(directory))
            return false;
        try
        {
            string disabledMarker = Path.Combine(Path.GetDirectoryName(directory), "offline-queue-disabled");
            if (File.Exists(disabledMarker))
                return false;
            Directory.CreateDirectory(directory);
            string fileName = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString("D13")
                + "-" + System.Diagnostics.Process.GetCurrentProcess().Id
                + "-" + Guid.NewGuid().ToString("N").Substring(0, 12) + ".json";
            string envelope = "{\"event\":" + eventJson
                + ",\"queuedAt\":" + JsonString(DateTime.UtcNow.ToString("o"))
                + ",\"lastError\":" + JsonString(Truncate(error.Message, 500)) + "}\n";
            using (var stream = new FileStream(Path.Combine(directory, fileName), FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
                writer.Write(envelope);
            PrunePendingEvents(directory);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void PrunePendingEvents(string directory)
    {
        var files = new List<string>(Directory.GetFiles(directory, "*.json"));
        files.Sort(StringComparer.OrdinalIgnoreCase);
        int obsolete = Math.Max(0, files.Count - MaxPendingEvents);
        for (int index = 0; index < obsolete; index++)
        {
            try { File.Delete(files[index]); } catch { }
        }
    }

    private static string ReadToken(Arguments args)
    {
        string tokenFile = Value(args, "token-file", "");
        return String.IsNullOrWhiteSpace(tokenFile) ? Value(args, "token", "") : File.ReadAllText(tokenFile, Encoding.UTF8).Trim();
    }

    private static string AddMetadata(string raw, string source)
    {
        string channel = Environment.GetEnvironmentVariable("FEISHU_AGENT_CHANNEL_ID") ?? "";
        string backend = Environment.GetEnvironmentVariable("FEISHU_AGENT_BRIDGE_BACKEND") ?? "";
        string metadata = "\"__notifier_source\":" + JsonString(source)
            + ",\"__notifier_channel_id\":" + JsonString(channel)
            + ",\"__notifier_bridge_backend\":" + JsonString(backend);
        return raw.Length == 2 ? "{" + metadata + "}" : "{" + metadata + "," + raw.Substring(1);
    }

    private static Arguments ParseArguments(string[] argv)
    {
        var result = new Arguments();
        for (int index = 0; index < argv.Length; index++)
        {
            string value = argv[index];
            if (value.StartsWith("--"))
            {
                result.Values[value.Substring(2)] = index + 1 < argv.Length ? argv[++index] : "";
            }
            else
            {
                result.Positional.Add(value);
            }
        }
        return result;
    }

    private static string FindJsonArgument(List<string> values)
    {
        foreach (string value in values)
            if (value.TrimStart().StartsWith("{")) return value;
        return "";
    }

    private static int ParsePort(string value)
    {
        int port;
        return Int32.TryParse(value, out port) && port > 0 && port <= 65535 ? port : 37561;
    }

    private static string Value(Arguments args, string key, string fallback)
    {
        string value;
        return args.Values.TryGetValue(key, out value) ? value : fallback;
    }

    private static string JsonString(string value)
    {
        var result = new StringBuilder("\"");
        foreach (char character in value ?? "")
        {
            switch (character)
            {
                case '"': result.Append("\\\""); break;
                case '\\': result.Append("\\\\"); break;
                case '\b': result.Append("\\b"); break;
                case '\f': result.Append("\\f"); break;
                case '\n': result.Append("\\n"); break;
                case '\r': result.Append("\\r"); break;
                case '\t': result.Append("\\t"); break;
                default:
                    if (character < 0x20) result.Append("\\u").Append(((int)character).ToString("x4"));
                    else result.Append(character);
                    break;
            }
        }
        return result.Append('"').ToString();
    }

    private static string Truncate(string value, int maximum)
    {
        value = value ?? "";
        return value.Length <= maximum ? value : value.Substring(0, maximum);
    }

    private static void TryWriteOutput(string value)
    {
        try
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(value);
            Console.OpenStandardOutput().Write(bytes, 0, bytes.Length);
        }
        catch { }
    }

    private static void TryWriteError(string value)
    {
        try
        {
            byte[] bytes = new UTF8Encoding(false).GetBytes(value + "\n");
            Console.OpenStandardError().Write(bytes, 0, bytes.Length);
        }
        catch { }
    }

    private sealed class Arguments
    {
        public readonly Dictionary<string, string> Values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        public readonly List<string> Positional = new List<string>();
    }
}
