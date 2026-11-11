Feature: Model picker search (GH-680)

  # Needs a real OpenCode binary (E2E_OPENCODE_BIN), isolated by the run (no login): the free OpenCode Zen models. Only structure is asserted.
  Scenario: Typing a name leaves only the matching models and hides the other groups
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    When I choose the engine "OpenCode"
    And I open the model chooser once the models have loaded
    Then the group "OpenCode" of the model chooser lists a model matching "deepseek"
    And the model chooser has a search field above the list
    And the model chooser lists at least 8 models
    When I search the model chooser for "deepseek"
    Then every listed model matches "deepseek"
    And the model chooser shows only the groups "OpenCode"
    And I capture "search deepseek"

  Scenario: The search matches the model id and the provider name
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    When I choose the engine "OpenCode"
    And I open the model chooser once the models have loaded
    Then the group "OpenCode" of the model chooser lists a model matching "deepseek"
    # "opencode/" is in the id of every model (provider/model) and in no name or provider name.
    When I search the model chooser for "opencode/"
    Then the model chooser lists at least 8 models
    And the model chooser shows only the groups "OpenCode"
    When I search the model chooser for "OpenCode"
    Then the model chooser lists at least 8 models
    And the model chooser shows only the groups "OpenCode"
    And I capture "search id and provider"

  Scenario: The keyboard picks a model and Escape closes the picker
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    When I choose the engine "OpenCode"
    And I open the model chooser once the models have loaded
    Then the group "OpenCode" of the model chooser lists a model matching "deepseek"
    And the model search field has the focus
    When I type "deepseek" without clicking the field
    And I press "ArrowDown" in the model chooser
    Then a listed model is highlighted
    When I press "Enter" in the model chooser
    Then the model chooser is closed
    And the toolbar shows the model that was highlighted
    And I capture "keyboard pick"
    When I open the model chooser once the models have loaded
    And I press "Escape" in the model chooser
    Then the model chooser is closed
    And the toolbar shows the model that was highlighted

  Scenario: A search without a match says so and keeps the footer
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    When I choose the engine "OpenCode"
    And I open the model chooser once the models have loaded
    Then the group "OpenCode" of the model chooser lists a model matching "deepseek"
    When I search the model chooser for "zzzqqq"
    Then the model chooser says "No models match"
    And the model chooser lists no model
    And the model chooser footer offers "Connect a provider"
    And the model chooser footer has no error
    And I capture "no match footer"

  Scenario Outline: The search field and the footer fit at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    When I choose the engine "OpenCode"
    And I open the model chooser once the models have loaded
    Then the group "OpenCode" of the model chooser lists a model matching "deepseek"
    And the model search field is visible inside the viewport
    And the model chooser footer is visible inside the viewport
    When I search the model chooser for "deepseek"
    Then every listed model matches "deepseek"
    And the model search field is visible inside the viewport
    And the model chooser footer is visible inside the viewport
    And the page has no horizontal scroll
    And I capture "layout <width>"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: Touch targets of the search field, the rows and the footer are 44px on a phone
    Given the viewport is 390x844
    And the device has a coarse touch pointer
    And OpenCode is set up in a scratch project
    When I choose the engine "OpenCode"
    And I open the model chooser once the models have loaded
    Then the group "OpenCode" of the model chooser lists a model matching "deepseek"
    And the model search field is at least 44px high
    And every model option is at least 44px high
    And the model chooser footer button "Connect a provider" is at least 44px high
    And the page has no horizontal scroll
    And I capture "phone 44px"

  Scenario: A Claude session's model picker still lists and picks models
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the model chooser
    Then the model chooser lists at least 2 models
    When I pick another model in the model chooser
    Then the toolbar shows the model that was picked
    And I capture "claude short list"
