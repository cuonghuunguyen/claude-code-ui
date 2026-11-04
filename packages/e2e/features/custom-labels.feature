Feature: Custom names and icons for projects and machines

  Scenario: A project gets a name and an emoji from its menu, the filter finds it by either name, Reset brings the folder name back
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    When I open the name and icon dialog of the scratch project
    And I set the label name to "Shop front"
    And I choose the emoji icon "🛒"
    And I save the label
    Then the sidebar shows the scratch project as "Shop front"
    And the sidebar avatar of the scratch project shows the emoji "🛒"
    And I capture "named-project"
    When I filter the sidebar by "Shop front"
    Then the sidebar still lists the scratch project
    When I filter the sidebar by the folder name of the scratch project
    Then the sidebar still lists the scratch project
    When I filter the sidebar by ""
    And I open the name and icon dialog of the scratch project
    And I reset the label
    Then the sidebar shows the folder name of the scratch project
    And the sidebar avatar of the scratch project shows no icon
    And I capture "label-reset"

  Scenario: A phone shows the dialog and the named project without horizontal scroll
    Given the viewport is 390x844
    And the app is open
    And I open the scratch project
    When I open the name and icon dialog of the scratch project
    And I set the label name to "Shop front"
    And I choose the emoji icon "🛒"
    Then the page has no horizontal scroll
    And I capture "label-dialog-phone"
    When I save the label
    And I open the sidebar drawer
    Then the sidebar shows the scratch project as "Shop front"
    And the page has no horizontal scroll
    And I capture "named-project-phone"

  Scenario: An uploaded image is cropped to a 64x64 icon, a file that is no image is refused
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    When I open the name and icon dialog of the scratch project
    And I choose the image icon "icon-wide.png"
    And I zoom and move the crop
    And I capture "label-crop"
    And I save the label
    Then the sidebar avatar of the scratch project is a 64x64 image
    And I capture "image-icon"
    When I open the name and icon dialog of the scratch project
    And I choose the image icon from a text file
    Then the label dialog shows an error
    And I capture "label-bad-file"

  Scenario: A rename in one browser shows in another without a reload
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project
    And a second page is open on the same daemon
    When I open the name and icon dialog of the scratch project
    And I set the label name to "Shared name"
    And I save the label
    Then the second page shows the scratch project as "Shared name"
    And I capture "second-page-named"

  Scenario: This machine is renamed in Settings even without WSL or Docker
    Given the viewport is 1440x900
    And the app is open
    When I open Settings › Sides
    Then Settings lists this machine
    When I rename this machine to "Laptop" with the emoji "💻"
    Then Settings lists this machine as "Laptop"
    And I capture "machine-renamed"
