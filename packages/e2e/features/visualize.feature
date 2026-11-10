Feature: Inline visualizations (GH-690)

  Scenario: Claude draws a chart inline
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    And the mode is "light"
    When I send the prompt "Use the visualize skill to draw monthly sales Jan 10, Feb 20, Mar 30 as a bar chart." and wait for the turn to end
    Then the visualization frame is shown with a fitting height and a chart
    And I note the background colour of the visualization frame
    And I capture "chart light desktop"
    When I set the mode to "dark"
    Then the background colour of the visualization frame changed
    And I capture "chart dark desktop"
    Given the viewport is 390x844
    Then the visualization frame fits the viewport width
    And the page has no horizontal scroll
    And I capture "chart dark phone"

  Scenario: A visualization cannot reach the app
    Given the viewport is 1440x900
    And a session whose reply has a visualization that probes the app
    Then the visualization reports "parent:blocked ls:blocked cookie:blocked fetch:blocked"
    And I capture "sandbox probe desktop"
    Given the viewport is 390x844
    Then the visualization frame fits the viewport width
    And the page has no horizontal scroll
    And I capture "sandbox probe phone"

  Scenario: With the setting off a visualization shows as code
    Given the viewport is 1440x900
    And a session whose reply has a visualization that probes the app
    Then the visualization frame is shown
    When I open Settings › Chat
    And I turn the inline visualizations switch off
    And I close Settings
    Then the reply shows the visualization as a code block without a frame
    And I capture "setting off code"
    When I open Settings › Chat
    And I turn the inline visualizations switch on
    And I close Settings
    Then the visualization frame is shown
