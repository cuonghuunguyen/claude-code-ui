Feature: The repository selector chooses which repository Changes shows (GH-390)

  Background:
    Given the viewport is 1440x900

  Scenario: The selector shows in the git modes of a project with several repositories and hides in Session changes
    Given the scratch project is a superproject with a dirty submodule and a nested repository
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the Changes toolbar has the repository selector
    And the repository selector shows the name of the scratch project and a branch
    And I capture "selector-closed"
    When I choose the "Against branch" diff mode
    Then the Changes toolbar has the repository selector
    When I choose the "Session changes" diff mode
    Then the Changes toolbar has no repository selector
    And I capture "session-changes-no-selector"

  Scenario: The selector opens a tree of the own repository, the submodule and the nested repositories
    Given the scratch project is a superproject with a dirty submodule and a nested repository
    And the scratch project also has the nested repository "zed"
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the repository selector
    Then the repository tree lists in order:
      | rel      | icon    | level |
      | .        | repo    | 1     |
      | libs/lib | archive | 2     |
      | inner    | repo    | 2     |
      | zed      | repo    | 2     |
    And the repository tree row "." is selected
    And I capture "tree-open"

  Scenario: The tree works with the keyboard and Escape gives the focus back
    Given the scratch project is a superproject with a dirty submodule and a nested repository
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the repository selector
    Then the focus is on the repository tree row "."
    When I press "ArrowDown"
    Then the focus is on the repository tree row "libs/lib"
    When I press "End"
    Then the focus is on the repository tree row "inner"
    When I press "ArrowUp"
    Then the focus is on the repository tree row "libs/lib"
    When I press "Home"
    Then the focus is on the repository tree row "."
    When I press "ArrowLeft"
    Then the repository tree row "." is collapsed
    When I press "ArrowRight"
    Then the repository tree row "." is expanded
    When I press "ArrowDown"
    And I press "Enter"
    Then the repository tree is closed
    And the repository selector shows "lib"
    When I open the repository selector
    And I press "Escape"
    Then the repository tree is closed
    And the focus is on the repository selector
    And I capture "keyboard-escape-focus"

  Scenario: Picking libs/lib shows its uncommitted changes and its branches
    Given the scratch project is a superproject with a dirty submodule and a nested repository
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Against branch" diff mode
    Then the Against branch list offers "main" and not "lib-only"
    When I close the open menu with Escape
    And I choose the "Uncommitted" diff mode
    And I open the repository selector
    And I pick the repository "libs/lib"
    Then the repository selector shows "lib"
    And the Changes list has a row ending in "a.txt" and none ending in "s.txt"
    And I capture "picked-lib-uncommitted"
    When I choose the "Against branch" diff mode
    Then the Against branch list offers "lib-only" and not "feat-x"
    And I capture "picked-lib-branches"

  Scenario: The choice is kept after a reload, in another session and per project
    Given the scratch project is a superproject with a dirty submodule and a nested repository
    And a second scratch project is a superproject with a dirty submodule and a nested repository
    And a Haiku session with one finished reply
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    And I open the repository selector
    And I pick the repository "libs/lib"
    Then the repository selector shows "lib"
    When I reload the page
    And I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the repository selector shows "lib"
    And I capture "after-reload-keeps-lib"
    When I open a new session of the scratch project
    And I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the repository selector shows "lib"
    And I capture "other-session-keeps-lib"
    When I open the second scratch project
    And I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the repository selector shows the name of the second scratch project
    And I capture "other-project-own-choice"

  Scenario: The superproject shows a dirty submodule row and a nested repository row and Show changes in switches the selector
    Given the scratch project is a superproject with a dirty submodule and a nested repository
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the submodule row "libs/lib" says "modified content (1 file"
    And I capture "superproject-submodule-row"
    And the nested repository row "inner" shows a repository badge and no untracked folder
    And the Changes header counts "2 Changed files"
    And I capture "superproject-nested-row"
    When I select the row "libs/lib" and click "Show changes in libs/lib"
    Then the repository selector shows "lib"
    And the Changes list has a row ending in "a.txt" and none ending in "s.txt"
    And I capture "show-changes-in-lib"

  Scenario: The selector opens as a full-width sheet on a phone
    Given the viewport is 390x844
    And the scratch project is a superproject with a dirty submodule and a nested repository
    And a Haiku session with one finished reply
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the Changes toolbar has the repository selector
    And I capture "phone-closed"
    When I open the repository selector
    Then the repository sheet is a full-width bottom sheet
    And every repository tree row is 44px high
    And the scrollWidth of the page is 390
    And I capture "phone-sheet-open"
