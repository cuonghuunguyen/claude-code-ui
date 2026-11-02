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

  Scenario: The Addons dialog fits a phone screen
    Given the example addon is installed and enabled
    And the viewport is 390x844
    When I open the Addons dialog
    Then the addon "example" is enabled
    And the page has no horizontal scroll
    And I capture "addons dialog phone"

  Scenario: An addon theme is picked like a built-in one and its CSS goes with the addon
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

  Scenario: An addon pane sits in the side panel and moves to the main area
    Given the example addon is installed and enabled
    And a Haiku session with one finished reply
    When I open the "Stats" addon pane in the side panel
    Then the addon pane shows the part counts of the session
    And I capture "addon pane side"
    When I move the "Stats" pane to the main area from its tab menu
    Then the "Stats" tab opens right of its session tab and has the focus
    And the addon pane shows the part counts of the session
    And I capture "addon pane main"

  Scenario: An addon sets a status entry and shows a toast
    Given the example addon is installed and enabled
    And a Haiku session with one finished reply
    When I open the "Stats" addon pane in the side panel
    And I click "Set status" in the addon pane
    Then the status bar shows "example" status "ready"
    When I click "Toast" in the addon pane
    Then a toast says "example: hello"
    And I capture "status and toast"

  Scenario: A call outside the approved capabilities is refused
    Given the example addon is installed and enabled
    And a Haiku session with one finished reply
    When I count the user messages
    And I open the "Stats" addon pane in the side panel
    And I click "Try to submit" in the addon pane
    Then a toast says "Addon example was refused: prompt.submit"
    And the pane shows a refused error
    When I open the Addons dialog
    Then the log of "example" lists "prompt.submit"
    And no new user message is shown
    And I capture "refused call"

  Scenario: A phone:false view is hidden on a phone
    Given the example addon is installed and enabled
    And the viewport is 390x844
    And a Haiku session with one finished reply
    Then the pane switcher does not list "Stats"
    And the page has no horizontal scroll
    And I capture "phone no stats"
