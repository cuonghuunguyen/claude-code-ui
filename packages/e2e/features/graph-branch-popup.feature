Feature: The Graph branch popup searches branches and offers branch actions (GH-671)

  Scenario: Speed search narrows the list, Enter filters the graph, Esc clears the query first
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "topic" that edits the first line of "a.txt"
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I open the Graph branch popup
    Then the branch popup search box is focused
    And the branch popup lists "main"
    And the branch popup lists "topic"
    And the branch popup does not list "origin/main"
    When I type "top" in the branch popup
    Then the branch popup lists "topic"
    And the branch popup does not list "main"
    And I capture "popup-search"
    When I press "Escape" in the branch popup
    Then the branch popup search box is empty
    And the branch popup lists "main"
    When I type "top" in the branch popup
    And I press "Enter" in the branch popup
    Then the Graph branch filter shows "topic"
    And I capture "popup-filtered"

  Scenario: Branch actions hide what can never work and Checkout runs from the popup
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "topic" that edits the first line of "a.txt"
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I open the Graph branch popup
    And I open the actions of the branch "main" in the branch popup
    Then the branch popup actions offer "Push"
    And the branch popup actions do not offer "Checkout"
    And I capture "popup-actions-current"
    When I press "ArrowLeft" in the branch popup actions
    And I open the actions of the branch "topic" in the branch popup
    Then the branch popup actions offer "Checkout"
    When I pick "Checkout" in the branch popup actions
    Then the Graph result line says "Checked out topic"
    And the project is on the branch "topic"
    And I capture "popup-checkout"

  Scenario: The popup fits a phone with 44px action buttons
    Given the viewport is 390x844
    And the scratch project is a git repository with an origin inside the allowed roots
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I open the Graph branch popup
    Then every branch popup action button is at least 44px high
    And the scrollWidth of the page is 390
    And I capture "popup-phone"
