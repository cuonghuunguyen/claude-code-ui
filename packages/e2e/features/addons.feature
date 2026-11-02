Feature: Addons (GH-516)

  Background:
    Given the viewport is 1440x900
    And the app is open
    And I open the scratch project

  Scenario: Installing the example addon from a local folder asks for approval first
    Given the example addon is not installed
    When I open the Addons dialog
    And I install the addon from the local folder of the example addon
    Then the approval card lists the capabilities of the example addon
    When I approve the addon
    Then the addon "example" is enabled
    And I capture "addon approved"

  Scenario: The Addons dialog fits a phone screen
    Given the example addon is installed and enabled
    And the viewport is 390x844
    When I open the Addons dialog
    Then the addon "example" is enabled
    And the page has no horizontal scroll
    And I capture "addons dialog phone"
