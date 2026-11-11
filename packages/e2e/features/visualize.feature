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

  Scenario: A question with visualizations: previews side by side, a slider fills the answer
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And the project has the question visual files
    And I start a new Haiku session
    When I send "Read q.md, a.md and b.md. Then use the AskUserQuestion tool exactly once: the question is the exact content of q.md, header Chart, two options: Flow with preview the exact content of a.md, and Bars with preview the exact content of b.md. Copy the file contents verbatim."
    Then the question shows its visualization and 2 option previews
    And the option previews are side-by-side
    And I capture "question visuals desktop"
    When I drag the slider in the question visualization to 70
    Then the own answer field holds "threshold 70"
    And I capture "question slider answer desktop"
    When I choose the option "Bars" from its preview
    And I capture "question preview chosen desktop"
    When I set the mode to "dark"
    And I capture "question visuals dark desktop"
    Given the viewport is 390x844
    Then the option previews are side-by-side
    And the page has no horizontal scroll
    And I capture "question visuals phone"
