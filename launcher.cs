using System;
using System.Diagnostics;
using System.IO;

namespace ContextShield
{
    class Program
    {
        static int Main(string[] args)
        {
            Console.Title = "ContextShield Gateway & Security Firewall";

            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            string cliJsPath = Path.Combine(appDir, "dist", "cli.js");

            // Locate node.exe
            string nodePath = FindNodeExecutable();
            if (string.IsNullOrEmpty(nodePath))
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("\n[ERROR] Node.js runtime was not detected on this system.");
                Console.ResetColor();
                Console.WriteLine("Please download and install Node.js from https://nodejs.org (LTS or Current).");
                Console.WriteLine("\nPress any key to exit...");
                Console.ReadKey();
                return 1;
            }

            // Ensure dist/cli.js is built
            if (!File.Exists(cliJsPath))
            {
                Console.ForegroundColor = ConsoleColor.Yellow;
                Console.WriteLine("[INFO] Building ContextShield distribution package...");
                Console.ResetColor();

                var buildProc = new Process
                {
                    StartInfo = new ProcessStartInfo
                    {
                        FileName = "cmd.exe",
                        Arguments = "/c npm run build",
                        WorkingDirectory = appDir,
                        UseShellExecute = false
                    }
                };
                buildProc.Start();
                buildProc.WaitForExit();

                if (!File.Exists(cliJsPath))
                {
                    Console.ForegroundColor = ConsoleColor.Red;
                    Console.WriteLine("[ERROR] Failed to compile TypeScript project. Please run 'npm run build' manually.");
                    Console.ResetColor();
                    Console.WriteLine("\nPress any key to exit...");
                    Console.ReadKey();
                    return 1;
                }
            }

            // Build argument string
            string nodeArgs;
            if (args.Length == 0)
            {
                // Double-click launch -> default to interactive controller menu
                nodeArgs = string.Format("\"{0}\" menu", cliJsPath);
            }
            else
            {
                nodeArgs = string.Format("\"{0}\" {1}", cliJsPath, string.Join(" ", args));
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = nodeArgs,
                WorkingDirectory = appDir,
                UseShellExecute = false
            };

            try
            {
                var process = Process.Start(startInfo);
                process.WaitForExit();
                return process.ExitCode;
            }
            catch (Exception ex)
            {
                Console.ForegroundColor = ConsoleColor.Red;
                Console.WriteLine("\n[ERROR] Failed to execute ContextShield: " + ex.Message);
                Console.ResetColor();
                Console.WriteLine("\nPress any key to exit...");
                Console.ReadKey();
                return 1;
            }
        }

        static string FindNodeExecutable()
        {
            // Check PATH first
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            string[] paths = pathEnv.Split(';');

            foreach (var dir in paths)
            {
                string cleanDir = dir.Trim('"', ' ');
                if (string.IsNullOrEmpty(cleanDir)) continue;

                string full = Path.Combine(cleanDir, "node.exe");
                if (File.Exists(full)) return full;
            }

            // Check standard program files locations
            string[] standardLocations = new string[]
            {
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe")
            };

            foreach (var loc in standardLocations)
            {
                if (File.Exists(loc)) return loc;
            }

            return null;
        }
    }
}
