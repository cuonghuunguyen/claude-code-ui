Feature: OpenCode prompting (GH-656)

  # The engine choice is remembered per run folder: every scenario picks OpenCode itself.
  # Needs a real OpenCode binary (E2E_OPENCODE_BIN). Prompts name the tool; only structure is asserted.
  # @model: DeepSeek V4.1 Flash with the owner's login (E2E_OPENCODE_AUTH names a copy of its auth file).
  # A skipped tool call fails the scenario once; the runner retries it once.
  @model
  Scenario: A prompt streams a reply and the turn ends
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    When I send the first prompt "Reply with exactly: OK"
    Then I see my prompt in the transcript
    And I see a reply from Claude
    And the turn has finished
    And I capture "reply"
    And the rewind button is enabled
    And the palette row "Ask aside" is enabled
    And the page has no horizontal scroll
    And I capture "rewind enabled"

  @model
  Scenario Outline: Allow once runs a bash command at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    When I pick the permission mode "Ask before edits"
    And I send the first prompt "Run `echo hi` with the bash tool and nothing else"
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

  @model
  Scenario: Deny with feedback marks the card denied and the assistant continues
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    When I pick the permission mode "Ask before edits"
    And I send the first prompt "Run `echo hi` with the bash tool and nothing else"
    Then I see a permission request
    When I deny the permission request with the feedback "Use another approach"
    Then the permission request is gone
    And the "echo hi" tool call is denied
    And the turn has finished
    And I capture "denied"

  @model
  Scenario Outline: The model picker is grouped and a picked model runs the next turn at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode has the owner's login
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
    When I close the open chooser
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    And I send the first prompt "Reply with exactly: OK"
    Then I see a reply from Claude
    And the turn has finished

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |
