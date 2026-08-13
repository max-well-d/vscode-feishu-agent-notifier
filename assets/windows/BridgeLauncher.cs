using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;

public static class BridgeLauncher
{
    public static int Main(string[] args)
    {
        try
        {
            string directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string executableName = Path.GetFileName(Assembly.GetExecutingAssembly().Location);
            bool isClaudeCli = executableName.StartsWith("claude-feishu-", StringComparison.OrdinalIgnoreCase)
                && executableName.IndexOf("wrapper", StringComparison.OrdinalIgnoreCase) < 0;
            string configName = isClaudeCli ? "launcher-cli.conf" : "launcher.conf";
            string configPath = Path.Combine(directory, configName);
            string[] config = File.ReadAllLines(configPath, Encoding.UTF8);
            if (config.Length < 6)
                throw new InvalidOperationException("launcher config requires runtime, script, mode, bridge config, fallback executable, and window mode");
            bool hideWindow = config[5] == "1";

            var allArgs = new List<string>();
            allArgs.Add(config[1]);
            allArgs.Add(config[2]);
            allArgs.Add("--config");
            allArgs.Add(config[3]);
            allArgs.Add("--fallback-executable");
            allArgs.Add(config[4]);
            allArgs.Add("--");
            allArgs.AddRange(args);

            var start = new ProcessStartInfo();
            start.FileName = config[0];
            start.Arguments = JoinArguments(allArgs);
            start.UseShellExecute = false;
            start.CreateNoWindow = hideWindow;
            if (hideWindow) start.WindowStyle = ProcessWindowStyle.Hidden;
            start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
            if (hideWindow) start.EnvironmentVariables["FEISHU_AGENT_BRIDGE_HIDE_WINDOW"] = "1";
            bool relay = Console.IsInputRedirected || Console.IsOutputRedirected || Console.IsErrorRedirected;
            start.RedirectStandardInput = relay;
            start.RedirectStandardOutput = relay;
            start.RedirectStandardError = relay;
            Process bridgeProcess;
            try
            {
                bridgeProcess = Process.Start(start);
                if (bridgeProcess == null)
                    throw new InvalidOperationException("bridge runtime did not create a process");
            }
            catch (Exception startError)
            {
                Console.Error.WriteLine("Feishu Agent bridge runtime failed; starting the original Agent: " + startError.Message);
                return RunOriginal(config[2], config[4], args, hideWindow);
            }
            using (Process process = bridgeProcess)
            {
                Thread input = null;
                Thread output = null;
                Thread error = null;
                if (relay)
                {
                    input = StartCopy(Console.OpenStandardInput(), process.StandardInput.BaseStream, true);
                    output = StartCopy(process.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
                    error = StartCopy(process.StandardError.BaseStream, Console.OpenStandardError(), false);
                }
                process.WaitForExit();
                if (output != null) output.Join();
                if (error != null) error.Join();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Feishu Agent bridge launcher failed: " + error.Message);
            return 1;
        }
    }

    private static int RunOriginal(string mode, string configuredExecutable, string[] args, bool hideWindow)
    {
        string executable = configuredExecutable;
        var forwarded = new List<string>(args);
        if (mode == "claude" && forwarded.Count > 0 && File.Exists(forwarded[0]))
        {
            executable = forwarded[0];
            forwarded.RemoveAt(0);
        }
        var start = new ProcessStartInfo();
        start.FileName = executable;
        start.Arguments = JoinArguments(forwarded);
        start.UseShellExecute = false;
        start.CreateNoWindow = hideWindow;
        if (hideWindow) start.WindowStyle = ProcessWindowStyle.Hidden;
        using (Process process = Process.Start(start))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static Thread StartCopy(Stream source, Stream destination, bool closeDestination)
    {
        Thread thread = new Thread(delegate()
        {
            try
            {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
                {
                    destination.Write(buffer, 0, count);
                    destination.Flush();
                }
            }
            catch (IOException) { }
            finally
            {
                if (closeDestination)
                {
                    try { destination.Close(); } catch { }
                }
            }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private static string JoinArguments(IEnumerable<string> args)
    {
        var result = new StringBuilder();
        foreach (string arg in args)
        {
            if (result.Length > 0) result.Append(' ');
            result.Append(QuoteArgument(arg));
        }
        return result.ToString();
    }

    private static string QuoteArgument(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return arg;
        var result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char value in arg)
        {
            if (value == '\\')
            {
                backslashes++;
            }
            else if (value == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
            }
            else
            {
                result.Append('\\', backslashes);
                result.Append(value);
                backslashes = 0;
            }
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }
}
