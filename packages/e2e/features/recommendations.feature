Feature: Recommendations (GH-518)

  Scenario: The Create worktree modal suggests connecting Jira once
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with an origin
    And I open the scratch project
    And Jira is not set up
    When I click the new worktree button of the scratch project
    Then the Create worktree modal is open
    And the modal shows the Jira hint
    And I capture "jira hint"
    When I click the Connect Jira hint
    Then Settings › Jira is open
    And I capture "jira settings from hint"
    When I close Settings
    And I click the new worktree button of the scratch project
    Then the Create worktree modal is open
    And the modal shows no Jira hint
    When I reload the page
    And I click the new worktree button of the scratch project
    Then the Create worktree modal is open
    And the modal shows no Jira hint

  Scenario: Show recommendations off: no Jira hint
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with an origin
    And I open the scratch project
    And Jira is not set up
    When I open Settings › General
    And I turn off Show recommendations
    Then Show recommendations is off
    And I capture "recommendations off"
    When I close Settings
    And I click the new worktree button of the scratch project
    Then the Create worktree modal is open
    And the modal shows no Jira hint

  Scenario: Opening files in tabs twice teaches middle-click
    Given the scratch project has the file "src/a.ts" with the text "export const a = 1;"
    And the scratch project has the file "notes.md" with the text "# Notes"
    And the viewport is 1440x900
    And a Haiku session with one finished reply
    When I open the Files tab of the side panel
    And I expand the tree folder "src"
    And I choose "Open in tab" in the tree menu of "src/a.ts"
    And I choose "Open in tab" in the tree menu of "notes.md"
    Then a toast says "Tip: middle-click a file in the tree to open it in its own tab."
    And I capture "middle-click tip"

  Scenario: The 15th open tab offers Clean up tabs
    Given the viewport is 1440x900
    And the app is open with 15 saved sessions in each of 1 projects
    Then no toast shows
    When I open 14 more saved sessions
    And I reload the page
    Then no toast shows
    When I open the next saved session
    Then the toast "15 tabs open. Clean up the ones you no longer need?" shows with the button "Show me"
    And I capture "cleanup tabs toast"
    When I click "Show me" in the toast "15 tabs open"
    Then the palette shows the Clean up tabs page
    And I capture "cleanup tabs palette"

  Scenario: Tabs of many projects overflowing the strip offer compact tabs
    Given the viewport is 1000x800
    And the app is open with 3 saved sessions in each of 3 projects
    When I open 6 more saved sessions
    Then no toast shows
    When I open the next saved session
    Then the toast "Many projects open. Turn on compact tabs?" shows with the button "Turn on"
    And I capture "compact tabs toast"
    When I click "Turn on" in the toast "Many projects open"
    Then compact tabs are on and tabs are grouped by project
    And I capture "compact tabs on"

  Scenario: Only one recommendation shows per page load
    Given the viewport is 1000x800
    And the app is open with 5 saved sessions in each of 3 projects
    When I open 10 more saved sessions
    And I open the next saved session
    Then the toast "Many projects open. Turn on compact tabs?" shows with the button "Turn on"
    When I dismiss the toast "Many projects open"
    And I open 4 more saved sessions
    Then 15 saved sessions are open
    And no toast shows
    And only "compactTabs" was marked as shown
    And I capture "second rule stays quiet"

  Scenario: A recommendation stacks with another toast
    Given the viewport is 1440x900
    And the app is open with 15 saved sessions in each of 1 projects
    When I open 15 more saved sessions
    Then the toast "15 tabs open. Clean up the ones you no longer need?" shows with the button "Show me"
    When I hover the toast "15 tabs open"
    And I run "Reset shortcut tips" from the command palette
    Then 2 toasts show
    And the toast "15 tabs open. Clean up the ones you no longer need?" shows with the button "Show me"
    And a toast says "Shortcut tips reset."
    And I capture "two toasts"

  Scenario: Two toasts fit a phone screen
    Given the viewport is 390x844
    And the app is open with 15 saved sessions in each of 1 projects
    When I open 15 more saved sessions
    Then the toast "15 tabs open. Clean up the ones you no longer need?" shows with the button "Show me"
    When I hover the toast "15 tabs open"
    And I run "Reset shortcut tips" from the command palette
    Then 2 toasts show
    And the page has no horizontal scroll
    And the page is exactly 390px wide
    And I capture "two toasts phone"

  Scenario: A recommendation toast closes with Dismiss
    Given the viewport is 1440x900
    And the app is open with 15 saved sessions in each of 1 projects
    When I open 15 more saved sessions
    Then the toast "15 tabs open. Clean up the ones you no longer need?" shows with the button "Show me"
    When I dismiss the toast "15 tabs open"
    Then no toast shows
    And I capture "toast dismissed"
