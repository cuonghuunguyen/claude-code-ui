Feature: OpenCode prompting (GH-656)

  # The engine choice is remembered per run folder: every scenario picks OpenCode itself.
  # Needs a real OpenCode binary (E2E_OPENCODE_BIN) and its free model: no login. Prompts name the tool; only structure is asserted.
  # A skipped tool call fails the scenario once; the runner retries it once.
  Scenario: A prompt streams a reply and the turn ends
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I send the first prompt "Reply with exactly: OK"
    Then I see my prompt in the transcript
    And I see a reply from Claude
    And the turn has finished
    And I capture "reply"

  # GH-682: OpenCode keeps a request cut off during a folder's MCP load as the folder's state, and every turn there then aborts. No request of ours is cut off.
  Scenario: A prompt in a folder whose MCP server loads slowly gets a reply
    Given the viewport is 1440x900
    And OpenCode has an MCP server that takes 8 seconds to load
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I send the first prompt "Reply with exactly: OK"
    Then I see a reply from Claude
    And the turn has finished
    And I capture "slow mcp reply"

  Scenario Outline: Allow once runs a bash command at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I send the first prompt "Run `echo hi` with the bash tool and nothing else"
    Then I see a permission request
    And the permission panel has no Edit content button
    And the page has no horizontal scroll
    And I capture "permission light"
    When I switch the theme mode to "dark"
    Then the page has no horizontal scroll
    And I capture "permission dark"
    When I allow the permission request
    Then the permission request is gone
    And the "echo hi" tool call is finished
    And the turn has finished
    And I capture "once done"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: Allow always shows the rule and skips the next panel
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I send the first prompt "Run `echo hi` with the bash tool and nothing else"
    Then I see a permission request
    And the permission rule line shows "Bash(echo *)"
    When I allow the permission request always
    Then the "echo hi" tool call is finished
    And the turn has finished
    When I send "Run `echo again` with the bash tool and nothing else"
    Then the "echo again" tool call is finished
    And the permission request is gone
    And the turn has finished
    And I capture "always"

  Scenario: Deny with feedback marks the card denied and the assistant continues
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I send the first prompt "Run `echo hi` with the bash tool and nothing else"
    Then I see a permission request
    When I deny the permission request with the feedback "Use another approach"
    Then the permission request is gone
    And the "echo hi" tool call is denied
    And the turn has finished
    And I capture "denied"

  Scenario Outline: A question panel is answered at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I send the first prompt "Use the question tool to ask me whether I prefer red or blue, with exactly those two options"
    Then I see a question request
    And the page has no horizontal scroll
    And I capture "question light"
    When I switch the theme mode to "dark"
    Then the page has no horizontal scroll
    And I capture "question dark"
    When I answer the question with its first option
    Then the question is answered
    And the turn has finished
    And I capture "question done"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: Stop interrupts a long turn
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I send the first prompt "Without using any tool, write 60 long paragraphs about the history of numbers"
    And the reply has started streaming
    And I stop the turn
    Then the turn has finished
    And the transcript shows the interrupted divider
    And I capture "stopped"

  Scenario Outline: The model picker is grouped and a picked model runs the next turn at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I open the model chooser
    Then the model chooser lists "Default" and the group "OpenCode"
    And the page has no horizontal scroll
    And I capture "models light"
    When I close the open chooser
    And I switch the theme mode to "dark"
    And I open the model chooser
    Then I capture "models dark"
    When I pick the first model of the group "OpenCode"
    And I send the first prompt "Reply with exactly: OK"
    Then I see a reply from Claude
    And the turn has finished

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: The permission chooser offers the OpenCode permission modes and no effort chooser
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I open the mode chooser
    Then the permission chooser offers exactly "Ask before edits, Edit automatically"
    And the effort chooser is absent
    And I capture "modes"

  Scenario Outline: Rewind and Ask aside are enabled at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    When I send the first prompt "Reply with exactly: OK"
    And the turn has finished
    Then the rewind button is enabled
    And the palette row "Ask aside" is enabled
    And the page has no horizontal scroll
    And I capture "rewind enabled"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: A subagent runs as a nested card
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And the project has a file "a.txt" with the text "alpha"
    When I send the first prompt "Use the task tool with subagent_type general to read a.txt and report its content"
    Then a subagent card is shown
    And the turn has finished
    And I capture "subagent"
