// Accessibility helpers for the Windows widget (docs/accessibility.md). widget.ps1 compiles this once with
// the .NET Framework's own compiler and keeps the DLL in its cache folder; it adds no dependency.
//
// WPF exposes plain Borders to UI Automation only through the text inside them, so screen readers cannot
// tell a status chip, a tab or a task row from a label. AccessibleBorder is still a Border (all mouse
// behaviour of the widget stays as it is), but it is keyboard-focusable, raises Activate on Enter / Space,
// and reports a role to UI Automation: button, list item, tab, check box, radio button, link, disclosure or toggle
// button, with the matching pattern (Invoke, SelectionItem, Toggle, ExpandCollapse) so Narrator can read and operate it.
// It also gives the press feedback (docs/design.md, "Motion"): fast, in C#, so long lists pay nothing for it.
using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace Saqme
{
    public class AccessibleBorder : Border
    {
        public static readonly RoutedEvent ActivateEvent = EventManager.RegisterRoutedEvent(
            "Activate", RoutingStrategy.Bubble, typeof(RoutedEventHandler), typeof(AccessibleBorder));
        public event RoutedEventHandler Activate { add { AddHandler(ActivateEvent, value); } remove { RemoveHandler(ActivateEvent, value); } }

        /// <summary>button | listitem | tab | toggle | togglebutton | radio | link | disclosure, or none (decoration, hidden
        /// from screen readers). A togglebutton is a button that stays pressed while what it opens is open (Settings).</summary>
        public string Role { get; set; }
        public bool IsSelected { get; set; }
        /// <summary>A toggle (a switch) or a togglebutton: on / pressed.</summary>
        public bool? IsChecked { get; set; }
        /// <summary>A disclosure (a button that shows or hides the part below it): whether that part is shown.</summary>
        public bool IsExpanded { get; set; }
        /// <summary>Enter / Space raise Activate (task rows leave these keys to the window's shortcuts).</summary>
        public bool ActivateOnKeys { get; set; }

        /// <summary>Press feedback: the tint while the mouse button is down on it (null: none). It fades back when let go.</summary>
        public Brush PressBrush { get; set; }
        /// <summary>Press feedback: its size while pressed, e.g. 0.92 for an icon (1: it keeps its size; a row only tints).</summary>
        public double PressScale { get; set; }
        /// <summary>The widget turns this off where nothing may move (its self-check, renders); Windows' own "Animation
        /// effects" off turns it off too. Without it a press only tints.</summary>
        public static bool Motion = true;
        public static bool MotionOn { get { return Motion && SystemParameters.ClientAreaAnimation && SystemParameters.UIEffects; } }

        public AccessibleBorder() { Role = "button"; Focusable = true; ActivateOnKeys = true; PressScale = 1; }

        public void RaiseActivate() { RaiseEvent(new RoutedEventArgs(ActivateEvent, this)); }

        // ---- press feedback: in fast (80 ms), out eased (120 ms). Only the innermost control under the pointer reacts (a
        // button in a row, not the row too); a decoration (role none) is part of the control it is in.
        bool pressed, tiedBorder;
        Brush restBrush, restBorder;
        SolidColorBrush fading; Brush fadingTo, fadingBorder;   // (a tint on its way back, and where it goes)
        static readonly IEasingFunction EaseOut = MakeEase();
        static IEasingFunction MakeEase() { var e = new CubicEase { EasingMode = EasingMode.EaseOut }; e.Freeze(); return e; }
        bool HasPress { get { return PressBrush != null || PressScale < 1; } }

        bool PressIsMine(object hit)
        {
            for (var d = hit as DependencyObject; d != null && !ReferenceEquals(d, this); d = Up(d))
            {
                var b = d as AccessibleBorder;
                if (b != null && b.Role != "none") return false;
            }
            return true;
        }
        static DependencyObject Up(DependencyObject d)
        {
            return (d is Visual || d is System.Windows.Media.Media3D.Visual3D) ? VisualTreeHelper.GetParent(d) : LogicalTreeHelper.GetParent(d);
        }

        protected override void OnPreviewMouseLeftButtonDown(MouseButtonEventArgs e)
        {
            base.OnPreviewMouseLeftButtonDown(e);
            if (HasPress && IsEnabled && PressIsMine(e.OriginalSource)) Press(true);
        }
        protected override void OnPreviewMouseLeftButtonUp(MouseButtonEventArgs e) { base.OnPreviewMouseLeftButtonUp(e); Press(false); }
        protected override void OnMouseLeave(MouseEventArgs e) { base.OnMouseLeave(e); Press(false); }
        protected override void OnLostMouseCapture(MouseEventArgs e) { base.OnLostMouseCapture(e); Press(false); }

        /// <summary>Pressed or let go (also for the widget's self-check).</summary>
        public void Press(bool down)
        {
            if (pressed == down) return;
            pressed = down;
            if (PressBrush != null)
            {
                if (down)
                {
                    // (a row whose edge has the row's colour at rest: the edge tints with it; pressed again while the tint
                    // fades back, its rest is where that fade goes)
                    bool refade = fading != null && ReferenceEquals(Background, fading);
                    restBrush = refade ? fadingTo : Background;
                    restBorder = refade && ReferenceEquals(BorderBrush, fading) ? fadingBorder : BorderBrush;
                    tiedBorder = restBorder != null && (ReferenceEquals(restBorder, restBrush) || (refade && ReferenceEquals(BorderBrush, fading)));
                    fading = null;
                    Background = PressBrush;
                    if (tiedBorder) BorderBrush = PressBrush;
                }
                else if (ReferenceEquals(Background, PressBrush)) FadeBack();   // (painted by someone else meanwhile: that stands)
            }
            if (PressScale < 1) ScaleTo(down ? PressScale : 1, down ? 80 : 120);
        }

        void FadeBack()
        {
            Brush to = restBrush, border = restBorder;
            bool tied = tiedBorder;
            restBrush = restBorder = null;
            var from = PressBrush as SolidColorBrush;
            var target = to as SolidColorBrush;
            if (!MotionOn || from == null || (to != null && target == null))
            {
                Background = to;
                if (tied) BorderBrush = border;
                return;
            }
            // towards a transparent rest without passing through another colour on the way
            Color end = target != null && target.Color.A > 0 ? target.Color : Color.FromArgb(0, from.Color.R, from.Color.G, from.Color.B);
            var b = new SolidColorBrush(from.Color);
            Background = b;
            if (tied) BorderBrush = b;
            fading = b; fadingTo = to; fadingBorder = tied ? border : null;
            var a = new ColorAnimation(end, TimeSpan.FromMilliseconds(120)) { EasingFunction = EaseOut };
            a.Completed += delegate
            {
                if (ReferenceEquals(Background, b)) Background = to;
                if (ReferenceEquals(BorderBrush, b)) BorderBrush = border;
                if (ReferenceEquals(fading, b)) fading = null;
            };
            b.BeginAnimation(SolidColorBrush.ColorProperty, a);
        }

        void ScaleTo(double to, int ms)
        {
            var st = RenderTransform as ScaleTransform;
            if (st == null || st.IsFrozen)
            {
                if (to >= 1) return;
                st = new ScaleTransform(1, 1);
                RenderTransform = st;
                RenderTransformOrigin = new Point(0.5, 0.5);
            }
            if (!MotionOn)
            {
                st.BeginAnimation(ScaleTransform.ScaleXProperty, null);
                st.BeginAnimation(ScaleTransform.ScaleYProperty, null);
                st.ScaleX = st.ScaleY = 1;
                return;
            }
            var a = new DoubleAnimation(to, TimeSpan.FromMilliseconds(ms)) { EasingFunction = EaseOut };
            st.BeginAnimation(ScaleTransform.ScaleXProperty, a);
            st.BeginAnimation(ScaleTransform.ScaleYProperty, a);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (ActivateOnKeys && !e.Handled && (e.Key == Key.Enter || e.Key == Key.Space) && Keyboard.Modifiers == ModifierKeys.None)
            {
                e.Handled = true;
                RaiseActivate();
            }
            base.OnKeyDown(e);
        }

        protected override AutomationPeer OnCreateAutomationPeer() { return new AccessibleBorderPeer(this); }
    }

    public class AccessibleBorderPeer : FrameworkElementAutomationPeer, IInvokeProvider, IToggleProvider, ISelectionItemProvider, IExpandCollapseProvider
    {
        public AccessibleBorderPeer(AccessibleBorder owner) : base(owner) { }
        AccessibleBorder B { get { return (AccessibleBorder)Owner; } }

        protected override AutomationControlType GetAutomationControlTypeCore()
        {
            switch (B.Role)
            {
                case "listitem": return AutomationControlType.ListItem;
                case "tab": return AutomationControlType.TabItem;
                case "toggle": return AutomationControlType.CheckBox;
                case "radio": return AutomationControlType.RadioButton;
                case "link": return AutomationControlType.Hyperlink;
                default: return AutomationControlType.Button;
            }
        }
        protected override string GetClassNameCore() { return "SaqmeControl"; }
        // a button, tab or switch is one thing to a screen reader: its name says it all (no icon-font glyphs
        // read out as text). A task row keeps its parts: status button, text, deadline, subtask count.
        protected override System.Collections.Generic.List<AutomationPeer> GetChildrenCore()
        {
            return B.Role == "listitem" && B.IsVisible ? base.GetChildrenCore() : null;
        }
        // hidden (collapsed) controls and decorations are not in the tree a screen reader walks
        protected override bool IsControlElementCore() { return B.Role != "none" && B.IsVisible; }
        protected override bool IsContentElementCore() { return B.Role != "none" && B.IsVisible; }

        public override object GetPattern(PatternInterface pattern)
        {
            string r = B.Role;
            if (pattern == PatternInterface.Invoke && (r == "button" || r == "link" || r == "disclosure" || r == "togglebutton")) return this;
            if (pattern == PatternInterface.Toggle && (r == "toggle" || r == "togglebutton")) return this;
            if (pattern == PatternInterface.SelectionItem && (r == "listitem" || r == "tab" || r == "radio")) return this;
            if (pattern == PatternInterface.ExpandCollapse && r == "disclosure") return this;
            return base.GetPattern(pattern);
        }

        // UI Automation calls come in on the UI thread; run the action after the call returns
        void Run()
        {
            if (!B.IsEnabled) throw new ElementNotEnabledException();
            B.Dispatcher.BeginInvoke(new Action(B.RaiseActivate));
        }
        void IInvokeProvider.Invoke() { Run(); }
        ToggleState IToggleProvider.ToggleState
        {
            get { return B.IsChecked == true ? ToggleState.On : (B.IsChecked == false ? ToggleState.Off : ToggleState.Indeterminate); }
        }
        void IToggleProvider.Toggle() { Run(); }
        bool ISelectionItemProvider.IsSelected { get { return B.IsSelected; } }
        IRawElementProviderSimple ISelectionItemProvider.SelectionContainer { get { return null; } }
        void ISelectionItemProvider.Select() { Run(); }
        void ISelectionItemProvider.AddToSelection() { Run(); }
        void ISelectionItemProvider.RemoveFromSelection() { }
        ExpandCollapseState IExpandCollapseProvider.ExpandCollapseState
        {
            get { return B.IsExpanded ? ExpandCollapseState.Expanded : ExpandCollapseState.Collapsed; }
        }
        void IExpandCollapseProvider.Expand() { if (!B.IsExpanded) Run(); }
        void IExpandCollapseProvider.Collapse() { if (B.IsExpanded) Run(); }
    }

    /// <summary>A StackPanel that UI Automation sees as a list (the tasks), a tab list (the projects) or a group.</summary>
    public class AccessiblePanel : StackPanel
    {
        /// <summary>list | tablist | group</summary>
        public string Role { get; set; }
        public AccessiblePanel() { Role = "list"; }
        protected override AutomationPeer OnCreateAutomationPeer() { return new AccessiblePanelPeer(this); }
    }

    public class AccessiblePanelPeer : FrameworkElementAutomationPeer
    {
        public AccessiblePanelPeer(AccessiblePanel owner) : base(owner) { }
        protected override AutomationControlType GetAutomationControlTypeCore()
        {
            string r = ((AccessiblePanel)Owner).Role;
            return r == "tablist" ? AutomationControlType.Tab : (r == "group" ? AutomationControlType.Group : AutomationControlType.List);
        }
        protected override string GetClassNameCore() { return "SaqmeList"; }
        protected override bool IsControlElementCore() { return true; }
    }
}
