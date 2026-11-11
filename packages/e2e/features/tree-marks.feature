Feature: The Files tree marks each file with its own repository's git status (GH-392)

  Background:
    Given the scratch project is a superproject with a moved listed submodule, an edited nested repository and a change of its own

  Scenario: Marks per repository, repository icons, a moved submodule, Ignore submodules, Show changes and Show graph from the tree, and marks after a daemon restart
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And I start a new Haiku session
    And I add "tools/inner" to the Settings Git list Scan repositories
    When I open the Files tab of the side panel
    And I expand the tree folder "tools/inner"
    And I expand the tree folder "libs/lib"
    Then the tree row "tools/inner/new.txt" shows the mark "U"
    And the tree row "tools/inner/a.txt" shows the mark "M"
    And the tree row "libs/lib/a.txt" shows the mark "M"
    And the tree row "s.txt" shows the mark "M"
    And the tree row "tools/inner" has no letter mark
    And the tree folder "tools" shows a dot
    And the Files tree has no repository selector
    And I capture "marks-per-repository"
    And the tree folder "tools/inner" has the repository icon labelled "Repository inner, branch main"
    And the tree folder "libs/lib" has the submodule icon labelled "Submodule lib, branch" and its checked-out commit
    And I capture "repository-icons"
    And the tree row "libs/lib" shows the mark "M"
    And the tree folder "libs" shows a dot
    And I capture "moved-submodule-m"
    When I open Settings and choose the Git group
    And I turn Ignore submodules on in Settings
    Then the tree row "libs/lib" has no letter mark
    And I capture "ignore-submodules-no-m"
    When I turn Ignore submodules off in Settings
    Then the tree row "libs/lib" shows the mark "M"
    When I close Settings
    And I open the Files tab of the side panel
    And I right click the tree row "libs/lib/a.txt"
    And I choose "Show changes" in the tree menu
    Then the Changes repository selector shows "lib"
    And the Changes row ending in "a.txt" is selected
    And I capture "show-changes-file-in-submodule"
    When I open the Files tab of the side panel
    And I right click the tree row "tools/inner"
    Then the tree menu offers "Show changes" and "Show graph"
    And I capture "repository-folder-menu"
    When I choose "Show changes" in the tree menu
    Then the Changes repository selector shows "inner"
    And the Changes mode is "Uncommitted"
    And the Changes list has a row ending in "new.txt" and none ending in "s.txt"
    And the Changes list has no row chosen by the tree
    And I capture "show-changes-repository"
    When I open the Files tab of the side panel
    And I right click the tree row "libs/lib"
    And I choose "Show graph" in the tree menu
    Then the Graph repository selector shows "lib"
    And the Graph lists the commit "lib two"
    And I capture "show-graph-submodule"
    When I open the Files tab of the side panel
    And the tree row "tools/inner/new.txt" shows the mark "U"
    And I restart the daemon
    Then the app is connected
    And the tree row "tools/inner/new.txt" shows the mark "U"
    And the tree row "tools/inner/a.txt" shows the mark "M"
    And I capture "marks-after-restart"

  Scenario: The tree with marks fits a phone
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    And I add "tools/inner" to the Settings Git list Scan repositories
    When I open the Files tab of the side panel
    And I expand the tree folder "tools/inner"
    And I expand the tree folder "libs/lib"
    Then the tree row "tools/inner/new.txt" shows the mark "U"
    And the tree row "libs/lib/a.txt" shows the mark "M"
    And the tree folder "tools/inner" has the repository icon labelled "Repository inner, branch main"
    And every tree row is at least 44px high
    And the tree has no horizontally clipped mark
    And the page has no horizontal scroll
    And I capture "phone-tree-marks"
