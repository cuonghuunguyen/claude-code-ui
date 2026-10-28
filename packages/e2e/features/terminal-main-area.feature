Feature: The terminal can live in the main area

  Scenario: The terminal moves to the main area and back with its shell and output
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I toggle the terminal from the titlebar
    Then a terminal shows in the bottom panel
    When I remember the shell title
    When I type "echo GH397MARK" in the terminal
    And I move the "Terminal" pane to the main area from its tab menu
    Then the Terminal tab is right of its session tab
    And the "Terminal" tab has the focus
    And the shell does not have the focus
    And the terminal shows "GH397MARK"
    And the Terminal tab has one shell
    And the bottom panel has no Terminal tab
    And the shell title is unchanged
    And I capture "terminal-main-moved"
    When I choose "Move Terminal to bottom panel" in the menu of the "Terminal" tab
    Then a toast says "Closed 1 Terminal tab"
    And there is no "Terminal" tab
    And the bottom panel shows the terminal with one shell
    And the terminal shows "GH397MARK"
    And the shell title is unchanged
    And I capture "terminal-back-bottom"

  Scenario: Main area as terminal position opens on Ctrl+Backquote and focuses the shell
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    Then there is no "Terminal" tab
    When I open the terminal with the shortcut
    Then there is one "Terminal" tab
    And the "Terminal" tab has the focus
    And the shell has the focus
    When I open the terminal with the shortcut
    Then there is one "Terminal" tab
    And the "Terminal" tab has the focus
    And the shell has the focus
    And I capture "terminal-main-shortcut"
    When I open a second session with a finished reply
    And I open the terminal with the shortcut
    Then there is one "Terminal" tab
    And the "Terminal" tab has the focus
    And the Terminal tab has one shell
    And I capture "terminal-main-same-folder"

  Scenario: A click on the Terminal tab focuses the shell and an arrow key does not
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And I open the terminal with the shortcut
    Then the shell has the focus
    When I click the session tab of the terminal
    And I click the Terminal strip tab with the mouse
    Then the Terminal tab is the selected tab
    And the shell has the focus
    When I click the session tab of the terminal
    And I select the Terminal strip tab with the arrow keys
    Then the Terminal tab is the selected tab
    And the shell does not have the focus
    And I capture "terminal-click-vs-arrow"

  Scenario: Closing the last shell closes the tab
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And I open the terminal with the shortcut
    Then the Terminal tab has one shell
    When I close the last shell of the Terminal tab
    Then there is no "Terminal" tab
    And I capture "terminal-last-shell-closed"

  Scenario: After a daemon restart the Terminal tab opens empty and starts no shell until New terminal
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And I open the terminal with the shortcut
    Then the Terminal tab has one shell
    When I restart the daemon
    Then the app is connected
    When I remember to count terminal requests
    And I reload the page
    Then there is one "Terminal" tab
    And the Terminal tab shows no shell and offers New terminal
    And the page started no new shell since the reload
    And I capture "terminal-restart-empty"
    When I click the Terminal tab New terminal button
    Then the Terminal tab has one shell
    And the page started one new shell
    And I capture "terminal-restart-plus"

  Scenario: Choosing a dock in Settings closes the Terminal tab with Undo
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And I open the terminal with the shortcut
    Then there is one "Terminal" tab
    When I open Settings and choose the terminal position "Bottom"
    Then a toast says "Closed 1 Terminal tab"
    And there is no "Terminal" tab
    And I capture "terminal-dock-closed-toast"
    When I click Undo in the toast
    Then there is one "Terminal" tab
    And I capture "terminal-dock-undo"

  Scenario: Phone lists the Terminal tab in the switcher, a tap on its row is passive, no horizontal scroll
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And I open the terminal with the shortcut
    Then the Terminal tab has one shell
    When I reload the page
    Then there is one "Terminal" tab
    And the Terminal tab has one shell
    When I dismiss the open toasts
    And I open the tab switcher
    Then the tab switcher lists a "Terminal" row
    And the page has no horizontal scroll
    And I capture "terminal-phone-switcher"
    When I pick the first session row in the tab switcher
    And I open the tab switcher
    And I pick the "Terminal" row in the tab switcher
    Then the Terminal tab has one shell
    And the shell does not have the focus
    And the page has no horizontal scroll
    And I capture "terminal-phone-terminal"

  Scenario: Phone: tapping the Terminal row after the shell had the focus keeps the keyboard closed
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And I open the terminal with the shortcut
    Then the Terminal tab has one shell
    And the shell has the focus
    When I dismiss the open toasts
    And I open the tab switcher
    And I pick the "Terminal" row in the tab switcher
    Then the Terminal tab has one shell
    And the shell does not have the focus
    And the page has no horizontal scroll
    And I capture "terminal-phone-row-after-focus"

  Scenario: Phone: tapping the Terminal row right after Ctrl+Backquote keeps the keyboard closed
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And I open the terminal with the shortcut
    And I dismiss the open toasts
    And I open the tab switcher
    And I pick the "Terminal" row in the tab switcher
    Then the Terminal tab has one shell
    And the shell does not have the focus
    And I capture "terminal-phone-row-fast"

  Scenario: A session in a second project folder opens a second Terminal tab
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And I open the terminal with the shortcut
    Then there is one "Terminal" tab
    When I open a session in a second project folder with a finished reply
    And I open the terminal with the shortcut
    Then there are 2 "Terminal" tabs
    And the Terminal tabs are labeled with the two project names
    And the Terminal tab of the second project is the selected tab
    And I capture "terminal-two-projects"

  Scenario: Ctrl+Backquote with the terminal in the main area focuses the shell once it loads when the user does nothing else
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open Settings and choose the terminal position "Main area"
    And the terminal code loads slowly
    And I open the terminal with the shortcut
    Then the shell has the focus within 20 seconds
    And I capture "terminal-shortcut-focus-after-load"
