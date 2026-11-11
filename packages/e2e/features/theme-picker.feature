Feature: Theme picker (GH-468)

  Background:
    Given the viewport is 1440x900
    And the app is open
    And the scratch project is a git repository with an origin
    And I open the scratch project

  Scenario: Appearance lists seven themes; the mode button cycles inside a theme; Dracula in light mode shows Default light; it fits a phone
    When I open Settings › Appearance
    Then the theme list is "Default, Catppuccin, Tokyo Night, Solarized, Nord, Dracula, One"
    And the theme "Dracula" is marked dark only
    And I capture "theme list"
    When I choose the theme "Nord"
    And I set the mode to "light"
    Then the app card colour is "#eceff4"
    And I capture "nord light"
    When I set the mode to "dark"
    Then the app card colour is "#2e3440"
    And I capture "nord dark"
    When I set the mode to "system"
    And the system colour scheme is "light"
    Then the app card colour is "#eceff4"
    And I capture "nord system light"
    When I choose the theme "Dracula"
    And I set the mode to "light"
    Then the app card colour is "#ffffff"
    And the Dracula light warning shows
    And I capture "dracula light"
    When I set the mode to "dark"
    Then the app card colour is "#282a36"
    And the Dracula light warning is gone
    Given the viewport is 390x844
    When I open Settings › Appearance
    Then the page has no horizontal scroll
    And the theme select is at least 44px high
    And I capture "phone appearance"

  Scenario: Picking a theme recolours the app, terminal, diff and graph without a reload
    Given the mode is "dark"
    And the scratch project has an uncommitted change
    When I mark the page
    And I choose the theme "Catppuccin"
    Then the app card colour is "#1e1e2e"
    When I open the terminal with the shortcut
    Then the terminal background is "#1e1e2e"
    When I open the Changes tab of the side panel
    And I choose the "Uncommitted" diff mode
    Then the diff background is the app card colour
    When I open the Graph tab of the side panel
    Then the Graph ref chip uses the theme colour
    And the page did not navigate
    And I capture "catppuccin dark"

  Scenario: The choice survives a reload with no flash
    Given the theme is "Tokyo Night" and the mode is "dark"
    And I record the theme before the app renders
    When I reload the page
    Then data-theme was "tokyonight" before the app rendered
    And the app card colour is "#1a1b26"
    And I capture "tokyo night after reload"

  Scenario: Surface style in every theme and mode
    When I open Settings
    Then the Settings dialog and the session pane keep their surface style in every theme and mode
    And I capture "surface"
