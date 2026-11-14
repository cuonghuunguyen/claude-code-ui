Feature: The Graph branch popup opens a branch's actions for a moving mouse only (GH-777)

  Scenario: A still mouse pointer over the popup opens no actions, a moving one does, and Escape on a phone keeps the list
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "topic" that edits the first line of "a.txt"
    And the app is open
    And I open the scratch project
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And the mouse pointer rests where the Graph branch popup will list its rows
    And I open the Graph branch popup with the keyboard
    Then the branch popup actions stay closed
    And I capture "pointer-still-wide"
    When I move the mouse over the branch popup row "topic"
    Then the branch popup actions offer "Checkout"
    And I capture "pointer-moved-wide"
    When I press "Escape" in the branch popup actions
    And I press "Escape" in the branch popup actions
    Then the branch popup is closed
    Given the viewport is 390x844
    When the mouse pointer rests where the Graph branch popup will list its rows
    And I open the Graph branch popup with the keyboard
    Then the branch popup actions stay closed
    And the branch popup lists "topic"
    And I capture "pointer-still-phone"
    When I move the mouse over the branch popup row "topic"
    Then the branch popup actions offer "Checkout"
    And the branch popup search box is hidden
    When I press "Escape" in the branch popup actions
    Then the branch popup actions stay closed
    And the branch popup lists "topic"
    And I capture "pointer-escape-phone"
