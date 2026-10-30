// Pokedex.exe: opens the Pokedex desktop app. It runs launcher.mjs (next to this program) with
// Node.js, without a console window; the launcher updates the app, starts the server and opens
// the app window. Built on your PC by install.ps1 with the C# compiler that comes with Windows.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class Program
{
    [STAThread]
    static int Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string launcher = Path.Combine(dir, "launcher.mjs");
        if (!File.Exists(launcher))
        {
            Show("launcher.mjs is missing from " + dir + ". Run the installer again.");
            return 1;
        }
        var info = new ProcessStartInfo("node", "\"" + launcher + "\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = dir,
            RedirectStandardError = true,
        };
        try
        {
            using (var process = Process.Start(info))
            {
                string errors = process.StandardError.ReadToEnd();
                process.WaitForExit();
                if (process.ExitCode != 0)
                {
                    Show("The Pokedex couldn't start.\n\n" + Tail(errors) + "\n\nMore details are in " + Path.Combine(dir, "launcher.log"));
                }
                return process.ExitCode;
            }
        }
        catch (Win32Exception)
        {
            Show("Node.js isn't installed (or isn't on the PATH).\n\nInstall the LTS version from https://nodejs.org, then open the Pokedex again.");
            return 1;
        }
    }

    static string Tail(string text)
    {
        text = (text ?? "").Trim();
        return text.Length > 800 ? "..." + text.Substring(text.Length - 800) : text;
    }

    static void Show(string message)
    {
        MessageBox.Show(message, "Pokedex", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
