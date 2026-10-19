Feature: The project chip on the new-session tab fits the screen

  Scenario: A long project name is truncated on a narrow screen and the chip stays inside it
    Given the viewport is 390x844
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    Then the project name is cut short with an ellipsis
    And the project chip is fully inside the viewport
    And the project chip keeps the full path as its title
    And the page has no horizontal scroll
    And I capture "narrow chip"

  Scenario: The project chip shows the whole name on a wide screen
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    Then the project name is shown in full
    And the project chip is fully inside the viewport
    And I capture "wide chip"
