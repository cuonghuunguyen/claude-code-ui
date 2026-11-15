Feature: New branch, Checkout and Smart checkout from the Graph branch menu (GH-561)

  Scenario: New branch from the commit details chip and from a commit row is checked out, on a desktop and on a phone
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work"
    And a Haiku session with one finished reply
    When I open the Graph tab of the side panel
    And I select the commit row "local work"
    And I open the branch menu on the chip "refs/heads/main" in the commit details
    Then the branch menu offers a new branch from "main"
    And I capture "details-chip-new-branch"
    When I press "Escape" in the branch popup
    Then the branch menu is closed
    When I open the branch menu on the commit row "initial"
    And I create the branch "topic" from the branch menu
    Then the Graph result line says "Created and checked out topic"
    And the project is on the branch "topic"
    And the project branch "topic" is at the commit "initial"
    And the scrollWidth of the page is 1440
    And I capture "new-branch"
    Given the viewport is 390x844
    When I open the branch menu on the commit row "initial"
    And I create the branch "phone-topic" from the branch menu
    Then the Graph result line says "Created and checked out phone-topic"
    And the project is on the branch "phone-topic"
    And the page has no horizontal scroll
    And I capture "new-branch-phone"
