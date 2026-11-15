Feature: Commit menu of the Graph: Undo Commit, Revert Commit, Cherry-Pick and Reset Current Branch to Here (GH-562)

  Scenario: Revert Commit and Cherry-Pick on a linear history
    Given the viewport is 1440x900
    And the scratch project is a git repository with an origin inside the allowed roots
    And the scratch project's main has the local commit "local work" that adds "work.txt"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Graph tab of the side panel
    And I open the commit menu on the row "local work"
    And I pick "Revert Commit" in the commit menu
    Then the Graph result line says "Reverted"
    And the last commit of the project is "Revert \"local work\""
    And I capture "reverted"
    When I choose "All branches" in the Graph branch filter
    And I open the commit menu on the row "a commit only on base-alt"
    And I capture "cherry-pick-menu"
    And I pick "Cherry-Pick" in the commit menu
    Then the Graph result line says "Cherry-picked"
    And the file "alt.txt" has the text "alt"
    And I capture "cherry-picked"
