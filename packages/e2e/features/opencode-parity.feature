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

  # GH-665 follow-ups. Scenarios without @model need no model reply.
  Scenario Outline: A ! command runs in an OpenCode session at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    And an OpenCode session "Shell me" with the messages "Hello from the seed" is created outside the app
    When I reload the page
    And I open the OpenCode session "Shell me"
    Then the conversation shows the user message "Hello from the seed"
    When I run the shell command "echo e2e-ok"
    Then the Bash card of "echo e2e-ok" shows the output "e2e-ok"
    And the shell command has ended
    And the conversation shows no assistant reply
    And the page has no horizontal scroll
    And I capture "bash light"
    When I switch the theme mode to "dark"
    Then the Bash card of "echo e2e-ok" shows the output "e2e-ok"
    And the page has no horizontal scroll
    And I capture "bash dark"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario Outline: /undo and /redo move the last message out and back at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    And an OpenCode session "Undo me" with the messages "First note about the build | Second note about tests" is created outside the app
    When I reload the page
    And I open the OpenCode session "Undo me"
    Then the conversation shows the user message "Second note about tests"
    When I type "/" in the prompt box
    Then the commands popup offers "compact", "undo" and "redo"
    And the page has no horizontal scroll
    And I capture "undo popup"
    When I send the slash command "/undo"
    Then the conversation does not show the user message "Second note about tests"
    And the conversation does not show the user message "/undo"
    And the conversation shows the user message "First note about the build"
    And the page has no horizontal scroll
    And I capture "undone"
    When I reload the page
    And I open the OpenCode session "Undo me"
    Then the conversation shows the user message "First note about the build"
    And the conversation does not show the user message "Second note about tests"
    And I capture "undone after reload"
    When I send the slash command "/redo"
    Then the conversation shows the user message "Second note about tests"
    And the conversation does not show the user message "/redo"
    And I capture "redone"
    When I reload the page
    And I open the OpenCode session "Undo me"
    Then the conversation shows the user message "Second note about tests"
    And I capture "redone after reload"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario Outline: The effort chooser follows the model's reasoning variants at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    When I pick the OpenCode model "GLM-5.3-Flash Free" in the model chooser
    And I open the effort chooser
    Then the effort chooser offers "Default, Low, High, Max"
    And the page has no horizontal scroll
    And I capture "effort levels light"
    When I close the open chooser
    And I switch the theme mode to "dark"
    And I open the effort chooser
    Then I capture "effort levels dark"
    When I close the open chooser
    And I pick the OpenCode model "Big Pickle" in the model chooser
    Then the effort chooser is hidden for this model
    And I capture "effort hidden"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: The prompt box names the engine of the session
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    When I choose the engine "Claude"
    Then the prompt box asks "Claude"
    And I capture "placeholder claude draft"
    When I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    Then the prompt box asks "OpenCode"
    When an OpenCode session "Named" with the messages "Hello from the seed" is created outside the app
    And I reload the page
    And I open the OpenCode session "Named"
    Then the conversation shows the user message "Hello from the seed"
    And the prompt box asks "OpenCode"
    And I capture "placeholder opencode session"

  Scenario: A missing OpenCode binary shows its error once and a relative path is refused under the field
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    When I set the OpenCode path setting to "/nonexistent/opencode-missing"
    And I close Settings
    And I choose the engine "OpenCode"
    And I send the first prompt "Hello OpenCode"
    Then the inline engine error offers "Open OpenCode settings"
    And the engine error text shows once
    And I capture "start error once"
    When I click the inline engine error button
    Then the OpenCode path setting "relative/opencode" is refused under the field
    And the OpenCode path setting "C:\opencode" is refused under the field
    And I capture "path refused"

  # @model: DeepSeek V4.1 Flash (the paid DeepSeek provider, not the "Free" one) with the owner's login (E2E_OPENCODE_AUTH names a copy of its auth file).
  @model
  Scenario: A message sent right after Stop starts the next turn and is answered
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    When I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    And I send the first prompt "Without using any tool, write 60 long paragraphs about the history of numbers"
    And the reply has started streaming
    And I stop the turn
    And I send "Reply with exactly: DONE"
    Then the conversation shows the user message "Reply with exactly: DONE"
    And the conversation shows an assistant reply after the user message "Reply with exactly: DONE"
    And the turn has finished
    And the transcript shows the interrupted divider
    And the page has no horizontal scroll
    And I capture "steering after stop"

  @model
  Scenario: /compact summarizes the conversation and the turn ends
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the OpenCode server of the daemon is running
    When I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    And I send the first prompt "Reply with exactly: OK"
    Then I see a reply from Claude
    And the turn has finished
    When I send the slash command "/compact"
    Then the transcript shows a compaction marker
    And the turn has finished
    And the page has no horizontal scroll
    And I capture "compacted"
