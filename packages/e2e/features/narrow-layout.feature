Feature: Narrow layout

  Scenario Outline: The tab switcher stays in the titlebar at <width>x<height>
    Given the viewport is <width>x<height>
    And a Haiku session with one finished reply
    Then the tab switcher is inside the titlebar and above the pane
    And the page has no horizontal scroll
    And I capture "titlebar"

    Examples:
      | width | height |
      | 390   | 844    |
      | 360   | 780    |
