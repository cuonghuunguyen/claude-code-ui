Feature: OpenCode engine (GH-655)

  # Needs a real OpenCode binary: E2E_OPENCODE_BIN=<path>. The daemon and the OpenCode it starts keep their data under the run folder.
  Scenario: The engine selector is labelled, keyboard operable and remembers the last engine
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    Then the engine selector is labelled "Engine: Claude"
    When I open the engine selector and pick "OpenCode" with the keyboard
    Then the engine selector is labelled "Engine: OpenCode"
    And I capture "selector OpenCode"
    When I send the first prompt "Hello OpenCode"
    And I reload the page
    And I open the New session tab
    Then the engine selector is labelled "Engine: OpenCode"
    And I capture "selector after reload"

  Scenario Outline: An OpenCode session is tagged in the sidebar and the header at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    When I open the engine selector
    Then I capture "selector open light"
    When I close the engine selector
    And I switch the theme mode to "dark"
    And I open the engine selector
    Then I capture "selector open dark"
    When I pick the engine "OpenCode" in the open selector
    And I send the first prompt "Hello OpenCode"
    Then the first prompt is refused with a message about a later version
    And the OpenCode session is tagged in its sidebar row
    And the page has no horizontal scroll
    And I capture "sidebar tag dark"
    When I open the first session row
    Then the session header, where shown, has the tag "OpenCode"
    And the page has no horizontal scroll
    And I capture "header tag dark"
    When I switch the theme mode to "light"
    Then I capture "header tag light"
    When I open the first session row
    Then I capture "sidebar tag light"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: A session created through the OpenCode API is listed under its project
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    When I choose the engine "OpenCode"
    And I send the first prompt "Start the server"
    And an OpenCode session "Made through the API" with the message "Hello from the API" is created outside the app
    And I reload the page
    Then the sidebar lists the OpenCode session "Made through the API" with the tag
    When I open the OpenCode session "Made through the API"
    Then the conversation shows the user message "Hello from the API"
    And I capture "api session"

  Scenario: A missing OpenCode binary is reported with a way to the setting
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    When I set the OpenCode path setting to "/nonexistent/opencode-missing"
    Then the OpenCode status says it was not found
    When I close Settings
    And I choose the engine "OpenCode"
    And I send the first prompt "Hello OpenCode"
    Then the inline engine error offers "Open OpenCode settings"
    And I capture "missing binary"
    When I click the inline engine error button
    Then Settings shows the OpenCode section
    And I capture "settings opencode"
