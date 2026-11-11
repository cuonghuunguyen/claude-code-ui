Feature: Addons (GH-516)

  Background:
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project

  Scenario: Installing the example addon from a local folder asks for approval first
    Given the example addon is not installed
    When I open the Addons dialog
    And I install the addon from the local folder of the example addon
    Then the approval card lists the capabilities of the example addon
    When I approve the addon
    Then the addon "example" is enabled
    And I capture "addon approved"

  Scenario: The addon band, command, status entry, toast, refused call, log and pane of the example addon
    Given the example addon is installed and enabled
    And a Haiku session with one finished reply
    Then the addon band of "example" is above the prompt box
    And the band shows the turn count
    And the band text is fully visible
    And I capture "addon band"
    When I count the user messages
    And I type "/example:" in the prompt box
    Then the command picker lists "/example:cmd" with its description
    When I run "/example:cmd release notes"
    Then the prompt box contains "Summarise this session: release notes"
    And no new user message is shown
    And I capture "addon command"
    When I open the "Stats" addon pane in the side panel
    Then the addon pane shows the part counts of the session
    And I capture "addon pane side"
    When I click "Set status" in the addon pane
    Then the status bar shows "example" status "ready"
    When I click "Toast" in the addon pane
    Then a toast says "example: hello"
    And I capture "status and toast"
    When I click "Try to submit" in the addon pane
    Then a toast says "Addon example was refused: prompt.submit"
    And the pane shows a refused error
    When I open the Addons dialog
    Then the log of "example" lists "prompt.submit"
    And no new user message is shown
    And I capture "refused call"
    When I press "Escape"
    And I click "Log" in the addon pane
    And I open the Addons dialog
    Then the log of "example" lists "pane clicked"
    When I reload the page
    And I open the Addons dialog
    Then the log of "example" lists "pane clicked"
    And I capture "addon log"
    When I clear the log of "example"
    Then the addon "example" has no log
    When I press "Escape"
    And I move the "Stats" pane to the main area from its tab menu
    Then the "Stats" tab opens right of its session tab and has the focus
    And the addon pane shows the part counts of the session
    And I capture "addon pane main"

  Scenario: The Addons dialog, the hidden phone:false view and the addon band fit a phone screen
    Given the example addon is installed and enabled
    And the viewport is 390x844
    And a Haiku session with one finished reply
    When I open the Addons dialog
    Then the addon "example" is enabled
    And the page has no horizontal scroll
    And I capture "addons dialog phone"
    When I press "Escape"
    Then the pane switcher does not list "Stats"
    And the addon band of "example" is above the prompt box
    And the band shows the turn count
    And the page has no horizontal scroll
    And I capture "addon band phone"

  Scenario: An addon theme is picked like a built-in one in dark and light mode, its CSS goes with the addon and uninstalling removes it
    Given the example addon is installed and enabled
    And the mode is "dark"
    When I choose the theme "Example Dusk"
    Then the app card colour is "#1d1a2e"
    And the addon stylesheet of "example" is applied
    And I capture "addon theme"
    When I disable the addon "example"
    Then the addon stylesheet of "example" is not applied
    And I capture "addon theme disabled"
    When I enable the addon "example"
    Then the addon stylesheet of "example" is applied
    Given the mode is "light"
    When I choose the theme "Example Dusk"
    Then the app card colour is "#f5f2fb"
    And the addon stylesheet of "example" is applied
    And I capture "addon theme light"
    When I uninstall the addon "example"
    Then the addon stylesheet of "example" is not applied
    And the addon "example" is not listed
    And I capture "uninstalled css"

  Scenario: An addon draws a code fence, with show raw
    Given the example addon is installed and enabled
    And a Haiku session with one finished reply
    When I send a prompt containing an "example" code fence with "hello addon"
    Then the user message shows the addon block of "example"
    When I click show raw
    Then the code fence source "hello addon" is shown
    And I capture "fence renderer"

  # Acceptance 2
  Scenario: An addon pane in a crowded side panel opens from the more panes menu; a session switch shows only the new session
    Given the example addon is installed and enabled
    And the scratch project is a git repository with an origin
    And a Haiku session with one finished reply
    When I narrow the side panel to its minimum
    Then the side panel shows the more panes button
    When I open the "Stats" addon pane from the more panes menu
    Then the addon pane shows the part counts of the session
    And I capture "addon pane overflow"
    When I note the part counts of the addon pane
    And I open a second session with a finished reply
    And I send the prompt "Reply with exactly: TWO" and wait for the reply
    Then the side panel shows exactly one addon pane frame
    And the addon pane shows more parts than noted
    And I capture "addon pane second session"
    When I open the first session tab
    Then the side panel shows exactly one addon pane frame
    And the addon pane shows the noted part counts
    And I capture "addon pane first session"

  Scenario: A git URL with a password is redacted in the Addons dialog
    Given the example addon is not installed
    When I install the example addon from a git URL with the password "s3cretpw"
    Then the Addons dialog shows the git source without "s3cretpw"
    And I capture "git url redacted card"
    When I approve the addon
    Then the addon "example" is enabled
    And the Addons dialog shows the git source without "s3cretpw"
    And I capture "git url redacted row"
