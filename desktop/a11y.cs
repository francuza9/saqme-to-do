// Accessibility helpers for the Windows widget (docs/accessibility.md). widget.ps1 compiles this once with
// the .NET Framework's own compiler and keeps the DLL in its cache folder; it adds no dependency.
//
// WPF exposes plain Borders to UI Automation only through the text inside them, so screen readers cannot
// tell a status chip, a tab or a task row from a label. AccessibleBorder is still a Border (all mouse
// behaviour of the widget stays as it is), but it is keyboard-focusable, raises Activate on Enter / Space,
// and reports a role to UI Automation: button, list item, tab, check box, radio button, link or disclosure, with
// the matching pattern (Invoke, SelectionItem, Toggle, ExpandCollapse) so Narrator can read and operate it.
using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Automation.Provider;
using System.Windows.Controls;
using System.Windows.Input;

namespace Saqme
{
    public class AccessibleBorder : Border
    {
        public static readonly RoutedEvent ActivateEvent = EventManager.RegisterRoutedEvent(
            "Activate", RoutingStrategy.Bubble, typeof(RoutedEventHandler), typeof(AccessibleBorder));
        public event RoutedEventHandler Activate { add { AddHandler(ActivateEvent, value); } remove { RemoveHandler(ActivateEvent, value); } }

        /// <summary>button | listitem | tab | toggle | radio | link | disclosure, or none (decoration, hidden from screen readers)</summary>
        public string Role { get; set; }
        public bool IsSelected { get; set; }
        public bool? IsChecked { get; set; }
        /// <summary>A disclosure (a button that shows or hides the part below it): whether that part is shown.</summary>
        public bool IsExpanded { get; set; }
        /// <summary>Enter / Space raise Activate (task rows leave these keys to the window's shortcuts).</summary>
        public bool ActivateOnKeys { get; set; }

        public AccessibleBorder() { Role = "button"; Focusable = true; ActivateOnKeys = true; }

        public void RaiseActivate() { RaiseEvent(new RoutedEventArgs(ActivateEvent, this)); }

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
            if (pattern == PatternInterface.Invoke && (r == "button" || r == "link" || r == "disclosure")) return this;
            if (pattern == PatternInterface.Toggle && r == "toggle") return this;
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
