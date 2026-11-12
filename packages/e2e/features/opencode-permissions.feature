Feature: OpenCode permissions follow the OpenCode config (GH-705)

  # @model: DeepSeek V4.1 Flash with the owner's login (E2E_OPENCODE_AUTH names a copy of its auth file).
  @model
  Scenario Outline: A new OpenCode session runs edits and bash without asking at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    Then the permission mode is still "Use OpenCode config"
    And the page has no horizontal scroll
    When I send the first prompt "Create a file named x.txt with the text hi using the write tool"
    Then the file "x.txt" exists in the project
    And no permission request is shown
    And the turn has finished
    When I send "Run `echo hi` with the bash tool and nothing else"
    Then the "echo hi" tool call is finished
    And no permission request is shown
    And I capture "config runs unasked"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  @model
  Scenario: A new OpenCode session asks before reading outside the project
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    When I send the first prompt "Read the file /etc/hosts with the read tool"
    Then I see a permission request
    And I capture "outside read asks"

  @model
  Scenario: bash asks when opencode.json sets bash to ask
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And the OpenCode project config sets the permission "bash" to "ask"
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    When I send the first prompt "Run `echo hi` with the bash tool and nothing else"
    Then I see a permission request
    When I allow the permission request
    Then the "echo hi" tool call is finished
    And I capture "config asks"

  @model
  Scenario: Ask before edits asks for bash and Use OpenCode config again runs it unasked in the same session
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    When I send the first prompt "Run `echo one` with the bash tool and nothing else"
    Then the "echo one" tool call is finished
    And no permission request is shown
    And the turn has finished
    When I pick the permission mode "Ask before edits"
    And I send "Run `echo two` with the bash tool and nothing else"
    Then I see a permission request
    When I allow the permission request
    Then the "echo two" tool call is finished
    And the turn has finished
    When I pick the permission mode "Use OpenCode config"
    And I send "Run `echo three` with the bash tool and nothing else"
    Then the "echo three" tool call is finished
    And no permission request is shown
    And I capture "config again"

  @model
  Scenario: An agent that denies edits wins in Use OpenCode config
    Given the viewport is 1440x900
    And OpenCode has the owner's login
    And the OpenCode project has a primary agent "review" that cannot edit
    And OpenCode is set up in a scratch project
    And I choose the engine "OpenCode"
    And I pick the OpenCode model "DeepSeek V4.1 Flash 1017" in the model chooser
    When I pick the agent "Review"
    And I send the first prompt "Create a file named x.txt with the text hi using the write tool"
    And I deny every permission request until the turn has finished
    Then the file "x.txt" does not exist in the project
    And no "x.txt" tool call completed
    And I capture "config agent deny"
