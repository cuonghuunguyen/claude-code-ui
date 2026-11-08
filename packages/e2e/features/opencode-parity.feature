Feature: OpenCode parity features (GH-658)

  # Needs a real OpenCode binary (E2E_OPENCODE_BIN). Sessions are seeded through the OpenCode API with noReply user messages: no model call.
  # Scenarios tagged @model make one short turn each and need the free model quota. Only structure is asserted.
  Scenario Outline: Rewind to an earlier message cuts the conversation at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    And an OpenCode session "Rewind me" with the messages "First note about the build | Second note about tests | Third note about docs" is created outside the app
    When I reload the page
    And I open the OpenCode session "Rewind me"
    Then the conversation shows the user message "Third note about docs"
    When I open the rewind panel of the message "Second note about tests"
    Then the rewind panel offers exactly "Restore conversation, Cancel"
    And the page has no horizontal scroll
    And I capture "rewind menu light"
    When I switch the theme mode to "dark"
    Then the page has no horizontal scroll
    And I capture "rewind menu dark"
    When I choose "Restore conversation" in the rewind panel
    Then the conversation does not show the user message "Second note about tests"
    And the conversation does not show the user message "Third note about docs"
    And the conversation shows the user message "First note about the build"
    And the prompt box holds "Second note about tests"
    And I capture "rewound"
    When I reload the page
    And I open the OpenCode session "Rewind me"
    Then the conversation shows the user message "First note about the build"
    And the conversation does not show the user message "Second note about tests"
    And the conversation does not show the user message "Third note about docs"
    And I capture "rewound after reload"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario Outline: Typing a slash lists the OpenCode commands at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    And an OpenCode session "Commands" with the messages "Hello from the seed" is created outside the app
    When I reload the page
    And I open the OpenCode session "Commands"
    Then the conversation shows the user message "Hello from the seed"
    When I type "/" in the prompt box
    Then the commands popup lists "init" and "review" with descriptions
    And the page has no horizontal scroll
    And I capture "commands light"
    When I switch the theme mode to "dark"
    Then the commands popup lists "init" and "review" with descriptions
    And I capture "commands dark"
    When I type "rev" in the prompt box
    And I select the highlighted command with the keyboard
    Then the commands popup is closed
    And the prompt box starts with "/review"
    And I capture "command selected"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: Claude-only controls are hidden in an OpenCode session
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    And an OpenCode session "No Claude controls" with the messages "Hello from the seed" is created outside the app
    When I reload the page
    And I open the OpenCode session "No Claude controls"
    Then the conversation shows the user message "Hello from the seed"
    And the toolbar shows no plan meter, no account switcher and no effort chooser
    And typing "!" in the prompt box does not start bash mode
    And I capture "no claude controls"

  Scenario: An OpenCode session attaches the orchestration MCP when orchestration is on
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    When I enable orchestration in Settings
    And an OpenCode session "Coordinator" with the messages "Hello from the seed" is created outside the app
    And I reload the page
    And I open the OpenCode session "Coordinator"
    Then the conversation shows the user message "Hello from the seed"
    And the OpenCode server lists a connected orchestration MCP for the project
    And I capture "orchestration attached"

  @model
  Scenario: Ask aside forks the session, answers, and Close removes the fork
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    And an OpenCode session "Aside owner" with the messages "The project is called Falcon | The build uses Gradle" is created outside the app
    When I reload the page
    And I open the OpenCode session "Aside owner"
    Then the conversation shows the user message "The build uses Gradle"
    When I ask the aside "Reply with exactly: OK" from the palette
    Then an aside popup shows
    And the aside popup answers with a reply
    And the OpenCode server lists 2 sessions for the project
    And the page has no horizontal scroll
    And I capture "aside popup"
    When I close the aside
    Then no aside popup shows
    And the OpenCode server lists 1 session for the project
    When the viewport is 390x844
    And I ask the aside "Reply with exactly: OK" from the palette
    Then an aside popup shows
    And the page has no horizontal scroll
    And I capture "aside popup phone"

  @model
  Scenario: Steering while OpenCode runs shows the steered message, one turn ends, and the context meter shows
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I send the first prompt "Count from 1 to 40, one number per line, then stop"
    And I steer the running turn with "Also say DONE at the end"
    Then the conversation shows the user message "Also say DONE at the end"
    And the turn has finished
    And the turn stays finished
    And the context meter shows a value
    And the page has no horizontal scroll
    And I capture "steered"
