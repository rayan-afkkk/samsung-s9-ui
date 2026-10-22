// OneShellNative: small Win32 helper process for OneShell.
// Talks to the Electron main process over stdin/stdout, one JSON object per line.
//   request:  {"id":1,"cmd":"listWindows","args":{...}}
//   response: {"id":1,"ok":true,"result":...}
//   event:    {"event":"winkey"}
// Written in C# 5 so it compiles with the csc.exe that ships with Windows 10/11.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace OneShell
{
    public static class Program
    {
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        static readonly BlockingCollection<string> Outbox = new BlockingCollection<string>();

        public static int Main(string[] argv)
        {
            try { Native.SetProcessDPIAware(); } catch { }
            Console.InputEncoding = new UTF8Encoding(false);
            var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            stdout.AutoFlush = true;

            var writer = new Thread(delegate ()
            {
                foreach (var line in Outbox.GetConsumingEnumerable())
                {
                    try { stdout.WriteLine(line); } catch { }
                }
            });
            writer.IsBackground = true;
            writer.Start();

            Hooks.Start();
            Taskbar.StartWatchdog();
            Emit("ready", new Dictionary<string, object> { { "build", Environment.OSVersion.Version.Build }, { "pid", Process.GetCurrentProcess().Id } });

            var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line2;
            while ((line2 = stdin.ReadLine()) != null)
            {
                if (line2.Trim().Length == 0) continue;
                Handle(line2);
            }

            // Parent went away (stdin closed): never leave the user without a taskbar.
            Cleanup();
            return 0;
        }

        public static void Cleanup()
        {
            try { Taskbar.Show(); } catch { }
            try { WorkArea.Restore(); } catch { }
        }

        public static void Emit(string name, Dictionary<string, object> data)
        {
            var o = data ?? new Dictionary<string, object>();
            o["event"] = name;
            Outbox.Add(Json.Serialize(o));
        }

        static void Handle(string line)
        {
            object id = null;
            try
            {
                var req = Json.Deserialize<Dictionary<string, object>>(line);
                id = req.ContainsKey("id") ? req["id"] : null;
                var cmd = (string)req["cmd"];
                var args = req.ContainsKey("args") && req["args"] != null
                    ? (Dictionary<string, object>)req["args"]
                    : new Dictionary<string, object>();
                var result = Commands.Run(cmd, args);
                Outbox.Add(Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", result } }));
            }
            catch (Exception ex)
            {
                Outbox.Add(Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", ex.Message } }));
            }
        }
    }

    static class Commands
    {
        static long L(Dictionary<string, object> a, string k) { return Convert.ToInt64(a[k]); }
        static int I(Dictionary<string, object> a, string k) { return Convert.ToInt32(a[k]); }
        static bool B(Dictionary<string, object> a, string k) { return a.ContainsKey(k) && Convert.ToBoolean(a[k]); }
        static string S(Dictionary<string, object> a, string k) { return a.ContainsKey(k) && a[k] != null ? a[k].ToString() : null; }
        static IntPtr H(Dictionary<string, object> a) { return new IntPtr(L(a, "hwnd")); }

        public static object Run(string cmd, Dictionary<string, object> a)
        {
            switch (cmd)
            {
                case "ping": return "pong";
                case "hideTaskbar": Taskbar.Hide(); return true;
                case "showTaskbar": Taskbar.Show(); return true;
                case "setWorkArea": WorkArea.Set(I(a, "top"), I(a, "bottom")); return true;
                case "restoreWorkArea": WorkArea.Restore(); return true;
                case "setHooks":
                    Hooks.WinKey = B(a, "winKey");
                    Hooks.WinA = B(a, "winA");
                    Hooks.WinTab = B(a, "winTab");
                    return true;
                case "setIgnorePids":
                    var list = new HashSet<int>();
                    foreach (var p in (System.Collections.IEnumerable)a["pids"]) list.Add(Convert.ToInt32(p));
                    Windows.IgnorePids = list;
                    return true;
                case "setRoundCorners": Windows.RoundCorners = B(a, "on"); return true;
                case "listWindows": return Windows.List();
                case "activate": Windows.Activate(H(a)); return true;
                case "close": Native.PostMessage(H(a), Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero); return true;
                case "minimize": Native.ShowWindow(H(a), Native.SW_MINIMIZE); return true;
                case "minimizeAll": Windows.MinimizeAll(); return true;
                case "place": Windows.Place(H(a), I(a, "x"), I(a, "y"), I(a, "w"), I(a, "h")); return true;
                case "topmost": Windows.Topmost(H(a), B(a, "on")); return true;
                case "toBottom": Windows.ToBottom(H(a)); return true;
                case "toolWindow": Windows.MakeToolWindow(H(a)); return true;
                case "foreground": return Native.GetForegroundWindow().ToInt64();
                case "icon": return Icons.Get(S(a, "path"));
                case "getVolume": return Audio.Get();
                case "setVolume": Audio.SetLevel(Convert.ToSingle(a["level"])); return Audio.Get();
                case "setMute": Audio.SetMute(B(a, "mute")); return Audio.Get();
                case "getBrightness": return Brightness.Get();
                case "setBrightness": Brightness.Set(I(a, "level")); return true;
                case "mediaKey": Keys.Media(S(a, "key")); return true;
                case "back": Keys.Tap(new ushort[] { Native.VK_BROWSER_BACK }); return true;
                case "screenshot": Keys.Tap(new ushort[] { (ushort)Native.VK_LWIN, Native.VK_SHIFT, (ushort)'S' }); return true;
                case "battery": return Power.Battery();
                case "optimize": return Power.Optimize();
                case "setDarkMode": Theme.SetDark(B(a, "on")); return true;
                case "getDarkMode": return Theme.IsDark();
                case "lockWorkstation": Native.LockWorkStation(); return true;
                case "exit": Program.Cleanup(); Environment.Exit(0); return true;
                default: throw new Exception("unknown command " + cmd);
            }
        }
    }

    // ---------------------------------------------------------------- keyboard + foreground hooks
    static class Hooks
    {
        public static volatile bool WinKey = true, WinA = true, WinTab = true;
        static Native.LowLevelKeyboardProc kbProc;   // keep delegates alive
        static Native.WinEventDelegate fgProc;
        static bool winDown, comboUsed, comboSwallowed;

        public static void Start()
        {
            var t = new Thread(Loop);
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }

        static void Loop()
        {
            kbProc = KeyboardProc;
            fgProc = ForegroundProc;
            var mod = Native.GetModuleHandle(null);
            Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, kbProc, mod, 0);
            Native.SetWinEventHook(Native.EVENT_SYSTEM_FOREGROUND, Native.EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, fgProc, 0, 0, Native.WINEVENT_OUTOFCONTEXT);
            Native.MSG msg;
            while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                Native.TranslateMessage(ref msg);
                Native.DispatchMessage(ref msg);
            }
        }

        static IntPtr KeyboardProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                var kb = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
                bool injected = (kb.flags & Native.LLKHF_INJECTED) != 0;
                int msg = wParam.ToInt32();
                bool down = msg == Native.WM_KEYDOWN || msg == Native.WM_SYSKEYDOWN;
                uint vk = kb.vkCode;

                if (!injected)
                {
                    if (vk == Native.VK_LWIN || vk == Native.VK_RWIN)
                    {
                        if (down)
                        {
                            if (!winDown) { winDown = true; comboUsed = false; comboSwallowed = false; }
                        }
                        else
                        {
                            winDown = false;
                            bool openDrawer = WinKey && !comboUsed;
                            if (openDrawer || comboSwallowed)
                            {
                                // Swallow the real Win-up and replay it after a "mask" key, so the
                                // Start menu sees a combo and stays closed (same trick AutoHotkey uses).
                                Keys.MaskedWinUp((ushort)vk);
                                if (openDrawer) Program.Emit("winkey", null);
                                return new IntPtr(1);
                            }
                        }
                    }
                    else if (winDown)
                    {
                        comboUsed = true;
                        if (vk == 'A' && WinA)
                        {
                            comboSwallowed = true;
                            if (down) Program.Emit("win_a", null);
                            return new IntPtr(1);
                        }
                        if (vk == Native.VK_TAB && WinTab)
                        {
                            comboSwallowed = true;
                            if (down) Program.Emit("win_tab", null);
                            return new IntPtr(1);
                        }
                    }
                }
            }
            return Native.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        static void ForegroundProc(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
        {
            try
            {
                var info = Windows.Describe(hwnd);
                if (Windows.RoundCorners) Windows.Round(hwnd);
                Program.Emit("foreground", info);
            }
            catch { }
        }
    }

    // ---------------------------------------------------------------- taskbar
    static class Taskbar
    {
        static volatile bool hidden;

        public static void Hide() { hidden = true; Apply(false); }
        public static void Show() { hidden = false; Apply(true); }

        static void Apply(bool show)
        {
            foreach (var h in Find())
                Native.ShowWindow(h, show ? Native.SW_SHOW : Native.SW_HIDE);
        }

        static List<IntPtr> Find()
        {
            var r = new List<IntPtr>();
            Native.EnumWindows(delegate (IntPtr h, IntPtr p)
            {
                var c = Windows.ClassName(h);
                if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") r.Add(h);
                return true;
            }, IntPtr.Zero);
            return r;
        }

        // Explorer restarts and some shell actions bring the taskbar back; keep it hidden.
        public static void StartWatchdog()
        {
            var t = new Thread(delegate ()
            {
                while (true)
                {
                    Thread.Sleep(1500);
                    if (!hidden) continue;
                    try
                    {
                        foreach (var h in Find())
                            if (Native.IsWindowVisible(h)) Native.ShowWindow(h, Native.SW_HIDE);
                    }
                    catch { }
                }
            });
            t.IsBackground = true;
            t.Start();
        }
    }

    static class WorkArea
    {
        static bool saved;
        static Native.RECT original;

        public static void Set(int top, int bottom)
        {
            if (!saved)
            {
                Native.SystemParametersInfo(Native.SPI_GETWORKAREA, 0, ref original, 0);
                saved = true;
            }
            var r = new Native.RECT
            {
                Left = 0,
                Top = top,
                Right = Native.GetSystemMetrics(Native.SM_CXSCREEN),
                Bottom = Native.GetSystemMetrics(Native.SM_CYSCREEN) - bottom
            };
            Native.SystemParametersInfo(Native.SPI_SETWORKAREA, 0, ref r, Native.SPIF_SENDCHANGE);
        }

        public static void Restore()
        {
            if (!saved) return;
            var r = original;
            Native.SystemParametersInfo(Native.SPI_SETWORKAREA, 0, ref r, Native.SPIF_SENDCHANGE);
            saved = false;
        }
    }

    // ---------------------------------------------------------------- windows
    static class Windows
    {
        public static HashSet<int> IgnorePids = new HashSet<int>();
        public static volatile bool RoundCorners = true;
        static readonly HashSet<string> SkipClasses = new HashSet<string> {
            "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW", "Windows.UI.Core.CoreWindow"
        };

        public static string ClassName(IntPtr h)
        {
            var sb = new StringBuilder(256);
            Native.GetClassName(h, sb, sb.Capacity);
            return sb.ToString();
        }

        static string Title(IntPtr h)
        {
            int n = Native.GetWindowTextLength(h);
            if (n <= 0) return "";
            var sb = new StringBuilder(n + 1);
            Native.GetWindowText(h, sb, sb.Capacity);
            return sb.ToString();
        }

        static bool Cloaked(IntPtr h)
        {
            int c = 0;
            try { Native.DwmGetWindowAttribute(h, Native.DWMWA_CLOAKED, out c, 4); } catch { }
            return c != 0;
        }

        static int Pid(IntPtr h)
        {
            uint pid;
            Native.GetWindowThreadProcessId(h, out pid);
            return (int)pid;
        }

        public static string ExePath(int pid)
        {
            var hp = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (hp == IntPtr.Zero) return null;
            try
            {
                var sb = new StringBuilder(1024);
                int size = sb.Capacity;
                return Native.QueryFullProcessImageName(hp, 0, sb, ref size) ? sb.ToString() : null;
            }
            finally { Native.CloseHandle(hp); }
        }

        // UWP apps live inside ApplicationFrameHost; find the real app process.
        static int RealPid(IntPtr h, int pid, string exe)
        {
            if (exe == null || !exe.EndsWith("ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) return pid;
            int found = pid;
            Native.EnumChildWindows(h, delegate (IntPtr c, IntPtr p)
            {
                int cp = Pid(c);
                if (cp != pid) { found = cp; return false; }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        static string AppName(string exe)
        {
            if (exe == null) return null;
            try
            {
                var vi = FileVersionInfo.GetVersionInfo(exe);
                if (!string.IsNullOrEmpty(vi.FileDescription)) return vi.FileDescription;
            }
            catch { }
            return Path.GetFileNameWithoutExtension(exe);
        }

        public static Dictionary<string, object> Describe(IntPtr h)
        {
            int pid = Pid(h);
            string exe = ExePath(pid);
            int real = RealPid(h, pid, exe);
            if (real != pid) exe = ExePath(real) ?? exe;
            return new Dictionary<string, object> {
                { "hwnd", h.ToInt64() }, { "title", Title(h) }, { "pid", real }, { "exe", exe },
                { "app", AppName(exe) }, { "minimized", Native.IsIconic(h) }, { "ours", IgnorePids.Contains(pid) },
                { "class", ClassName(h) }
            };
        }

        static bool IsAppWindow(IntPtr h)
        {
            if (!Native.IsWindowVisible(h)) return false;
            if (Native.GetWindow(h, Native.GW_OWNER) != IntPtr.Zero) return false;
            long ex = Native.GetWindowLongPtr(h, Native.GWL_EXSTYLE).ToInt64();
            if ((ex & Native.WS_EX_TOOLWINDOW) != 0) return false;
            if (Native.GetWindowTextLength(h) == 0) return false;
            if (SkipClasses.Contains(ClassName(h))) return false;
            if (Cloaked(h)) return false;
            if (IgnorePids.Contains(Pid(h))) return false;
            return true;
        }

        public static List<Dictionary<string, object>> List()
        {
            var fg = Native.GetForegroundWindow();
            var r = new List<Dictionary<string, object>>();
            Native.EnumWindows(delegate (IntPtr h, IntPtr p)
            {
                if (IsAppWindow(h))
                {
                    var d = Describe(h);
                    d["foreground"] = h == fg;
                    Native.RECT rc;
                    Native.GetWindowRect(h, out rc);
                    d["width"] = rc.Right - rc.Left;
                    d["height"] = rc.Bottom - rc.Top;
                    r.Add(d);
                }
                return true;
            }, IntPtr.Zero);
            return r; // EnumWindows walks top-to-bottom z-order, i.e. most recent first
        }

        public static void Activate(IntPtr h)
        {
            if (Native.IsIconic(h)) Native.ShowWindow(h, Native.SW_RESTORE);
            else Native.ShowWindow(h, Native.SW_SHOW);
            var fg = Native.GetForegroundWindow();
            uint dummy;
            uint fgThread = Native.GetWindowThreadProcessId(fg, out dummy);
            uint me = Native.GetCurrentThreadId();
            bool attached = fgThread != me && Native.AttachThreadInput(me, fgThread, true);
            Native.BringWindowToTop(h);
            Native.SetForegroundWindow(h);
            if (attached) Native.AttachThreadInput(me, fgThread, false);
            if (Native.GetForegroundWindow() != h)
            {
                // Pressing Alt grants the right to change the foreground window.
                Native.keybd_event(Native.VK_MENU, 0, 0, UIntPtr.Zero);
                Native.SetForegroundWindow(h);
                Native.keybd_event(Native.VK_MENU, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
            }
        }

        public static void MinimizeAll()
        {
            foreach (var w in List())
                Native.ShowWindow(new IntPtr(Convert.ToInt64(w["hwnd"])), Native.SW_MINIMIZE);
        }

        public static void Place(IntPtr h, int x, int y, int w, int hgt)
        {
            Native.ShowWindow(h, Native.SW_RESTORE);
            Native.SetWindowPos(h, IntPtr.Zero, x, y, w, hgt, Native.SWP_NOZORDER | Native.SWP_SHOWWINDOW);
        }

        public static void Topmost(IntPtr h, bool on)
        {
            Native.SetWindowPos(h, on ? Native.HWND_TOPMOST : Native.HWND_NOTOPMOST, 0, 0, 0, 0,
                Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_SHOWWINDOW);
        }

        static bool IsDesktopClass(string c) { return c == "Progman" || c == "WorkerW"; }

        // Put our desktop window directly below the lowest app window, i.e. just above the real
        // Windows desktop (Progman). HWND_BOTTOM would put it underneath Progman and hide it.
        public static void ToBottom(IntPtr self)
        {
            IntPtr lowest = IntPtr.Zero;
            Native.EnumWindows(delegate (IntPtr h, IntPtr p)
            {
                if (h == self || !Native.IsWindowVisible(h)) return true;
                if (IsDesktopClass(ClassName(h)) || Cloaked(h)) return true;
                long ex = Native.GetWindowLongPtr(h, Native.GWL_EXSTYLE).ToInt64();
                if ((ex & Native.WS_EX_TOPMOST) != 0) return true;
                lowest = h;
                return true;
            }, IntPtr.Zero);
            Native.SetWindowPos(self, lowest == IntPtr.Zero ? Native.HWND_TOP : lowest, 0, 0, 0, 0,
                Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE);
        }

        public static void MakeToolWindow(IntPtr h)
        {
            long ex = Native.GetWindowLongPtr(h, Native.GWL_EXSTYLE).ToInt64();
            ex = (ex | Native.WS_EX_TOOLWINDOW) & ~Native.WS_EX_APPWINDOW;
            Native.SetWindowLongPtr(h, Native.GWL_EXSTYLE, new IntPtr(ex));
        }

        // Windows 11 only (build 22000+): ask DWM for rounded corners. No-op on Windows 10.
        public static void Round(IntPtr h)
        {
            if (Environment.OSVersion.Version.Build < 22000) return;
            int pref = 2; // DWMWCP_ROUND
            try { Native.DwmSetWindowAttribute(h, Native.DWMWA_WINDOW_CORNER_PREFERENCE, ref pref, 4); } catch { }
        }
    }

    // ---------------------------------------------------------------- icons
    static class Icons
    {
        static readonly Dictionary<string, string> Cache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        // Returns a PNG data URL of the best icon we can get for a file (exe, lnk, ...).
        public static string Get(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            lock (Cache)
            {
                string hit;
                if (Cache.TryGetValue(path, out hit)) return hit;
            }
            string url = null;
            var info = new Native.SHFILEINFO();
            var res = Native.SHGetFileInfo(path, 0, ref info, (uint)Marshal.SizeOf(info), Native.SHGFI_SYSICONINDEX);
            if (res != IntPtr.Zero)
            {
                url = FromList(Native.SHIL_JUMBO, info.iIcon, true) ?? FromList(Native.SHIL_EXTRALARGE, info.iIcon, false);
            }
            lock (Cache) Cache[path] = url;
            return url;
        }

        static string FromList(int list, int index, bool rejectSmall)
        {
            IntPtr himl;
            var iid = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950"); // IID_IImageList
            if (Native.SHGetImageList(list, ref iid, out himl) != 0 || himl == IntPtr.Zero) return null;
            IntPtr hicon = Native.ImageList_GetIcon(himl, index, Native.ILD_TRANSPARENT);
            if (hicon == IntPtr.Zero) return null;
            try
            {
                using (var icon = Icon.FromHandle(hicon))
                using (var bmp = icon.ToBitmap())
                {
                    // Old apps only have 32/48px art; the jumbo list then pads it into a corner.
                    if (rejectSmall && OnlyTopLeft(bmp, 48)) return null;
                    using (var ms = new MemoryStream())
                    {
                        bmp.Save(ms, ImageFormat.Png);
                        return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
                    }
                }
            }
            finally { Native.DestroyIcon(hicon); }
        }

        static bool OnlyTopLeft(Bitmap b, int size)
        {
            if (b.Width <= size) return false;
            for (int y = 0; y < b.Height; y += 4)
                for (int x = 0; x < b.Width; x += 4)
                    if ((x >= size || y >= size) && b.GetPixel(x, y).A > 0) return false;
            return true;
        }
    }

    // ---------------------------------------------------------------- audio (Core Audio)
    static class Audio
    {
        static IAudioEndpointVolume Endpoint()
        {
            var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            IMMDevice dev;
            Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0 /*eRender*/, 1 /*eMultimedia*/, out dev));
            var iid = typeof(IAudioEndpointVolume).GUID;
            object o;
            Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out o));
            return (IAudioEndpointVolume)o;
        }

        public static Dictionary<string, object> Get()
        {
            var ep = Endpoint();
            float level; bool mute;
            ep.GetMasterVolumeLevelScalar(out level);
            ep.GetMute(out mute);
            return new Dictionary<string, object> { { "level", Math.Round(level * 100) }, { "mute", mute } };
        }

        public static void SetLevel(float percent)
        {
            var g = Guid.Empty;
            var ep = Endpoint();
            ep.SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, percent)) / 100f, ref g);
            if (percent > 0) ep.SetMute(false, ref g);
        }

        public static void SetMute(bool mute)
        {
            var g = Guid.Empty;
            Endpoint().SetMute(mute, ref g);
        }
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorCom { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid ctx);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
        [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid ctx);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid ctx);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    // ---------------------------------------------------------------- brightness (laptop panels via WMI)
    static class Brightness
    {
        public static object Get()
        {
            try
            {
                using (var s = new ManagementObjectSearcher("root\\WMI", "SELECT CurrentBrightness FROM WmiMonitorBrightness"))
                    foreach (ManagementObject mo in s.Get())
                        return Convert.ToInt32(mo["CurrentBrightness"]);
            }
            catch { }
            return null; // external monitors don't expose brightness
        }

        public static void Set(int level)
        {
            using (var s = new ManagementObjectSearcher("root\\WMI", "SELECT * FROM WmiMonitorBrightnessMethods"))
                foreach (ManagementObject mo in s.Get())
                    mo.InvokeMethod("WmiSetBrightness", new object[] { (uint)1, (byte)Math.Max(0, Math.Min(100, level)) });
        }
    }

    // ---------------------------------------------------------------- keys
    static class Keys
    {
        public static void Media(string key)
        {
            ushort vk = key == "next" ? Native.VK_MEDIA_NEXT_TRACK
                      : key == "prev" ? Native.VK_MEDIA_PREV_TRACK
                      : Native.VK_MEDIA_PLAY_PAUSE;
            Tap(new[] { vk });
        }

        // Press all keys in order, release in reverse.
        public static void Tap(ushort[] vks)
        {
            var inputs = new List<Native.INPUT>();
            foreach (var vk in vks) inputs.Add(Key(vk, false));
            for (int i = vks.Length - 1; i >= 0; i--) inputs.Add(Key(vks[i], true));
            Send(inputs);
        }

        public static void MaskedWinUp(ushort winVk)
        {
            Send(new List<Native.INPUT> { Key(Native.VK_MASK, false), Key(Native.VK_MASK, true), Key(winVk, true) });
        }

        static Native.INPUT Key(ushort vk, bool up)
        {
            var i = new Native.INPUT { type = Native.INPUT_KEYBOARD };
            i.u.ki.wVk = vk;
            i.u.ki.dwFlags = up ? Native.KEYEVENTF_KEYUP : 0;
            if (vk == Native.VK_LWIN || vk == Native.VK_RWIN || vk >= 0xA6 && vk <= 0xB7) i.u.ki.dwFlags |= Native.KEYEVENTF_EXTENDEDKEY;
            return i;
        }

        static void Send(List<Native.INPUT> inputs)
        {
            var arr = inputs.ToArray();
            Native.SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(Native.INPUT)));
        }
    }

    // ---------------------------------------------------------------- power / memory
    static class Power
    {
        public static Dictionary<string, object> Battery()
        {
            Native.SYSTEM_POWER_STATUS s;
            Native.GetSystemPowerStatus(out s);
            bool has = s.BatteryFlag != 128 && s.BatteryFlag != 255 && s.BatteryLifePercent != 255;
            return new Dictionary<string, object> {
                { "hasBattery", has }, { "percent", has ? (int)s.BatteryLifePercent : 100 }, { "charging", s.ACLineStatus == 1 }
            };
        }

        static ulong AvailMem()
        {
            var m = new Native.MEMORYSTATUSEX();
            m.dwLength = (uint)Marshal.SizeOf(typeof(Native.MEMORYSTATUSEX));
            Native.GlobalMemoryStatusEx(ref m);
            return m.ullAvailPhys;
        }

        // Samsung's "Optimize now": trim the working set of every process we're allowed to touch.
        public static Dictionary<string, object> Optimize()
        {
            ulong before = AvailMem();
            int count = 0;
            foreach (var p in Process.GetProcesses())
            {
                try { if (Native.EmptyWorkingSet(p.Handle)) count++; } catch { }
                finally { p.Dispose(); }
            }
            Thread.Sleep(300);
            ulong after = AvailMem();
            long freed = (long)after - (long)before;
            return new Dictionary<string, object> { { "freedMB", Math.Max(0, freed / (1024 * 1024)) }, { "processes", count } };
        }
    }

    static class Theme
    {
        const string Key = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

        public static bool IsDark()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(Key))
            {
                object v = k == null ? null : k.GetValue("AppsUseLightTheme");
                return v != null && Convert.ToInt32(v) == 0;
            }
        }

        public static void SetDark(bool dark)
        {
            using (var k = Registry.CurrentUser.CreateSubKey(Key))
            {
                k.SetValue("AppsUseLightTheme", dark ? 0 : 1, RegistryValueKind.DWord);
                k.SetValue("SystemUsesLightTheme", dark ? 0 : 1, RegistryValueKind.DWord);
            }
            UIntPtr r;
            Native.SendMessageTimeout(Native.HWND_BROADCAST, Native.WM_SETTINGCHANGE, UIntPtr.Zero, "ImmersiveColorSet",
                Native.SMTO_ABORTIFHUNG, 200, out r);
        }
    }

    // ---------------------------------------------------------------- P/Invoke
    static class Native
    {
        public const int WH_KEYBOARD_LL = 13, WM_KEYDOWN = 0x100, WM_SYSKEYDOWN = 0x104;
        public const uint LLKHF_INJECTED = 0x10;
        public const uint VK_LWIN = 0x5B, VK_RWIN = 0x5C, VK_TAB = 0x09;
        public const ushort VK_SHIFT = 0x10, VK_MASK = 0xE8, VK_BROWSER_BACK = 0xA6;
        public const ushort VK_MEDIA_NEXT_TRACK = 0xB0, VK_MEDIA_PREV_TRACK = 0xB1, VK_MEDIA_PLAY_PAUSE = 0xB3;
        public const byte VK_MENU = 0x12;
        public const uint KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, INPUT_KEYBOARD = 1;
        public const uint EVENT_SYSTEM_FOREGROUND = 3, WINEVENT_OUTOFCONTEXT = 0;
        public const int SW_HIDE = 0, SW_SHOW = 5, SW_MINIMIZE = 6, SW_RESTORE = 9;
        public const uint WM_CLOSE = 0x10, WM_SETTINGCHANGE = 0x1A, SMTO_ABORTIFHUNG = 2;
        public const int GWL_EXSTYLE = -20, GW_OWNER = 4;
        public const long WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000, WS_EX_TOPMOST = 0x8;
        public const int DWMWA_CLOAKED = 14, DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        public const uint SPI_GETWORKAREA = 0x30, SPI_SETWORKAREA = 0x2F, SPIF_SENDCHANGE = 0x2;
        public const int SM_CXSCREEN = 0, SM_CYSCREEN = 1;
        public const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;
        public static readonly IntPtr HWND_TOP = IntPtr.Zero, HWND_BOTTOM = new IntPtr(1), HWND_TOPMOST = new IntPtr(-1), HWND_NOTOPMOST = new IntPtr(-2), HWND_BROADCAST = new IntPtr(0xffff);
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const uint SHGFI_SYSICONINDEX = 0x4000;
        public const int SHIL_EXTRALARGE = 2, SHIL_JUMBO = 4;
        public const uint ILD_TRANSPARENT = 0x1;

        public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
        public delegate void WinEventDelegate(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        public struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)]
        public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion u; }
        [StructLayout(LayoutKind.Sequential)]
        public struct SYSTEM_POWER_STATUS { public byte ACLineStatus, BatteryFlag, BatteryLifePercent, SystemStatusFlag; public int BatteryLifeTime, BatteryFullLifeTime; }
        [StructLayout(LayoutKind.Sequential)]
        public struct MEMORYSTATUSEX { public uint dwLength, dwMemoryLoad; public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct SHFILEINFO
        {
            public IntPtr hIcon; public int iIcon; public uint dwAttributes;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
        }

        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetWindowsHookEx(int id, LowLevelKeyboardProc fn, IntPtr mod, uint thread);
        [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventDelegate fn, uint pid, uint thread, uint flags);
        [DllImport("user32.dll")] public static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG msg);
        [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG msg);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc fn, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc fn, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
        [DllImport("user32.dll")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, UIntPtr w, string l, uint flags, uint timeout, out UIntPtr result);
        [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfo(uint action, uint param, ref RECT r, uint winIni);
        [DllImport("user32.dll")] public static extern bool LockWorkStation();
        [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr hp, int flags, StringBuilder sb, ref int size);
        [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS s);
        [DllImport("kernel32.dll")] public static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX m);
        [DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr hp);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SHGetFileInfo(string path, uint attrs, ref SHFILEINFO info, uint size, uint flags);
        [DllImport("shell32.dll", EntryPoint = "#727")] public static extern int SHGetImageList(int list, ref Guid iid, out IntPtr himl);
        [DllImport("comctl32.dll")] public static extern IntPtr ImageList_GetIcon(IntPtr himl, int index, uint flags);
    }
}
