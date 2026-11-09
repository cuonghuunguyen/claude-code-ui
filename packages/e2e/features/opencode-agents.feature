Feature: OpenCode agents (GH-684)

  # Needs a real OpenCode binary (E2E_OPENCODE_BIN) with an isolated config: the scratch project's opencode.json adds the primary agent "review" (edit denied).
  # The free OpenCode model needs no login. Prompts name the tool; only structure and files are asserted.
  Scenario: The agent chooser lists the primary agents next to the permission chooser
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And the OpenCode project has a primary agent "review" that cannot edit
    And I choose the engine "OpenCode"
    When I open the agent chooser
    Then the agent chooser offers exactly "Build, Plan, Review"
    And the agent chooser comes before the permission chooser
    And I capture "agent chooser"

  Scenario: The permission chooser of an OpenCode session has no Plan entry
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And the OpenCode project has a primary agent "review" that cannot edit
    And I choose the engine "OpenCode"
    When I open the permission chooser
    Then the permission chooser offers exactly "Ask before edits, Edit automatically"
    And I capture "permission chooser"

  Scenario: Plan runs the next prompt as the plan agent and survives a daemon restart
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And the OpenCode project has a primary agent "review" that cannot edit
    And the OpenCode server has started
    And I choose the engine "OpenCode"
    When I pick the agent "Plan"
    And I send the first prompt "Create a file named x.txt with the text hi using the write tool"
    And the turn has finished
    Then the agent chooser shows "Plan"
    And the file "x.txt" does not exist in the project
    And I capture "plan turn"
    When I restart the OpenCode daemon
    And I reload the page
    And I open the first session row
    Then the agent chooser shows "Plan"
    And I capture "plan restored"

  Scenario: Shift+Tab in the prompt box cycles the agents
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And the OpenCode project has a primary agent "review" that cannot edit
    And the OpenCode server has started
    And I choose the engine "OpenCode"
    Then the agent chooser shows "Build"
    When I press "Shift+Tab" in the prompt box
    Then the agent chooser shows "Plan"
    And I capture "cycled plan"
    When I press "Shift+Tab" in the prompt box
    Then the agent chooser shows "Review"
    When I press "Shift+Tab" in the prompt box
    Then the agent chooser shows "Build"

  Scenario: An agent that denies edits wins over Edit automatically
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    And the OpenCode project has a primary agent "review" that cannot edit
    And the OpenCode server has started
    And I choose the engine "OpenCode"
    When I pick the agent "Review"
    And I pick the permission mode "Edit automatically"
    And I send the first prompt "Create a file named x.txt with the text hi using the write tool"
    And the turn has finished
    Then the file "x.txt" does not exist in the project
    And the permission request is gone
    And the "x.txt" tool call is denied
    And I capture "edit refused"

  Scenario Outline: Both choosers are reachable at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    And the OpenCode project has a primary agent "review" that cannot edit
    And the OpenCode server has started
    And I choose the engine "OpenCode"
    When I open the agent and permission choosers
    Then both choosers are visible
    And each chooser is at least 44px tall on a phone
    And the page has no horizontal scroll
    And I capture "choosers"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: A Claude session keeps the permission mode chooser
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I choose the engine "Claude"
    And I start a new Haiku session
    When I open the mode chooser
    Then the mode chooser offers exactly "Ask before edits, Edit automatically, Plan mode"
    And there is no agent chooser
    And I capture "claude modes"
