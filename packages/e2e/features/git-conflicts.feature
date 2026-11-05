Feature: Merge and Rebase from the branch menu, and the conflict banner of the Changes tab (GH-560)

  Scenario: A merge that conflicts shows the banner in the Changes tab, on a desktop and on a phone
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "feature" that conflicts with main on "a.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I choose "All branches" in the Graph branch filter
    And I open the branch menu on the chip "refs/heads/feature"
    And I pick the branch menu item "merge" and confirm its dialog
    And I open the Changes tab of the side panel
    Then the conflict banner says "Merge in progress" and lists "a.txt"
    And the project has a merge in progress
    And I capture "merge-banner"
    Given the viewport is 390x844
    When I open the Changes tab of the side panel
    Then the conflict banner and its buttons are inside the viewport
    And the page has no horizontal scroll
    And I capture "merge-banner-phone"

  Scenario: Continue is refused while markers remain, then finishes the merge once the file is fixed
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "feature" that conflicts with main on "a.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I choose "All branches" in the Graph branch filter
    And I open the branch menu on the chip "refs/heads/feature"
    And I pick the branch menu item "merge" and confirm its dialog
    And I open the Changes tab of the side panel
    And I click "Continue" in the conflict banner
    Then the Changes error shows "Conflict markers remain in a.txt"
    And the file "a.txt" still has its conflict markers
    And the project has a merge in progress
    And I capture "continue-refused"
    When I resolve "a.txt" on disk
    And I click "Continue" in the conflict banner
    Then the Changes result line says "Continued the merge"
    And the conflict banner is not shown
    And the last commit of the project is a merge of "feature"
    And I capture "merge-continued"

  Scenario: Abort restores HEAD and the working tree
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "feature" that conflicts with main on "a.txt"
    And the project head is remembered
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I choose "All branches" in the Graph branch filter
    And I open the branch menu on the chip "refs/heads/feature"
    And I pick the branch menu item "merge" and confirm its dialog
    And I open the Changes tab of the side panel
    And I click "Abort" in the conflict banner
    And I confirm the abort in the conflict banner
    Then the Changes result line says "Aborted the merge"
    And the conflict banner is not shown
    And the project head is the remembered one
    And the project has no operation in progress
    And I capture "merge-aborted"

  Scenario Outline: An operation a terminal started shows the banner after Reload
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "feature" that conflicts with main on "a.txt"
    And <setup>
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I reload the Changes tab from disk
    Then the conflict banner says "<title>" and lists "a.txt"
    And I capture "<shot>"

    Examples:
      | setup                                                          | title                    | shot        |
      | the scratch project has a cherry-pick of "feature" in progress | Cherry-pick in progress  | cherry-pick |
      | the scratch project has a revert in progress on "a.txt"        | Revert in progress       | revert      |
      | the scratch project has a stash pop conflict on "a.txt"        | Unmerged files           | stash-pop   |

  Scenario: Resolve with Claude fills the prompt box and starts no turn
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "feature" that conflicts with main on "a.txt"
    And a Haiku session with one finished reply
    And the scratch project has a cherry-pick of "feature" in progress
    When I open the Changes tab of the side panel
    And I reload the Changes tab from disk
    And I click "Resolve with Claude" in the conflict banner
    Then the prompt box starts with "Resolve the cherry-pick conflicts in"
    And the session has 1 user message
    And I capture "resolve-prompt"

  Scenario: A clean merge shows no banner
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "feature" that changes only "f.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I choose "All branches" in the Graph branch filter
    And I open the branch menu on the chip "refs/heads/feature"
    And I pick the branch menu item "merge" and confirm its dialog
    Then the Graph result line says "Merged feature"
    When I open the Changes tab of the side panel
    Then the conflict banner is not shown
    And the last commit of the project is a merge of "feature"
    And I capture "clean-merge"

  Scenario: A clean rebase shows no banner
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project has the branch "feature" that changes only "f.txt"
    And the scratch project has checked out "feature"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I choose "All branches" in the Graph branch filter
    And I open the branch menu on the chip "refs/heads/main"
    And I pick the branch menu item "rebase" and confirm its dialog
    Then the Graph result line says "Rebased onto main"
    When I open the Changes tab of the side panel
    Then the conflict banner is not shown
    And the history of the project is linear
    And I capture "clean-rebase"
