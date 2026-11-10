Feature: OpenCode model picker (GH-679)

  # Needs a real OpenCode binary (E2E_OPENCODE_BIN), isolated by the run (no login). Only structure is asserted.
  Scenario Outline: A new OpenCode session lists the OpenCode models on a cold server at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    When I choose the engine "OpenCode"
    And I open the model chooser
    Then the group "OpenCode" of the model chooser lists a model matching "deepseek"
    And the model chooser footer offers "Connect a provider"
    And the model chooser footer has no error
    And the page has no horizontal scroll
    And I capture "models cold <width>"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: After a daemon restart the model list is still complete
    Given the viewport is 1440x900
    And OpenCode is set up in a scratch project
    When I choose the engine "OpenCode"
    And I open the model chooser
    Then the group "OpenCode" of the model chooser lists a model matching "deepseek"
    When I close the open chooser
    And I restart the daemon of the OpenCode scenario
    And I reload the page
    And I open the New session tab
    And I choose the engine "OpenCode"
    And I open the model chooser
    Then the group "OpenCode" of the model chooser lists a model matching "deepseek"
    And the model chooser footer has no error
    And I capture "models after restart"

  Scenario Outline: Connect a provider from the model picker leads to DeepSeek in Settings at <width>x<height>
    Given the viewport is <width>x<height>
    And OpenCode is set up in a scratch project
    When I choose the engine "OpenCode"
    And I open the model chooser
    And I click "Connect a provider" in the model chooser footer
    Then Settings shows the OpenCode section
    When I show the OpenCode providers
    And I search the OpenCode providers for "deepseek"
    Then the provider row "DeepSeek" is in the connect list
    And the page has no horizontal scroll
    And I capture "connect deepseek <width>"

    Examples:
      | width | height |
      | 1440  | 900    |
      | 390   | 844    |

  Scenario: The picker rows and footer are 44px high on a phone
    Given the viewport is 390x844
    And the device has a coarse touch pointer
    And OpenCode is set up in a scratch project
    When I choose the engine "OpenCode"
    And I open the model chooser
    Then the group "OpenCode" of the model chooser lists a model matching "deepseek"
    And the model chooser footer button "Connect a provider" is at least 44px high
    And every model chooser option is at least 44px high
    And the page has no horizontal scroll
    And I capture "picker 44px"
