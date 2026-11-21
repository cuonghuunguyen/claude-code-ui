Feature: OpenCode 2 engine (GH-863)

  # Needs a real OpenCode 2 binary (E2E_OPENCODE2_BIN, 2.3.0 or newer). The model is a local fake (support/fake-model.ts): no login, no provider;
  # each prompt names what the fake does. Only structure is asserted.
  Scenario Outline: OpenCode 2 prompts, asks before a command and reaches claude-ui's tools at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode 2 is set up in a scratch project with a local fake model
    And I choose the engine "OpenCode"
    When I pick the permission mode "Ask before edits"
    And I send the first prompt "Run echo"
    Then I see a permission request
    And the page has no horizontal scroll
    And I capture "permission"
    When I allow the permission request
    Then the permission request is gone
    And the "echo hi" tool call is finished
    And the turn has finished
    When I send "Run an inline task"
    Then the inline task card is done
    And the turn has finished
    And the page has no horizontal scroll
    And I capture "inline task"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |
