Feature: Compact group chip menus

  Background:
    Given compact tab groups are on

  Scenario: Desktop hover menu lists only the group's tabs
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I hover the group chip
    Then the group menu lists the group's tab rows
    And the group menu has no Clean up, Close other groups or Close group
    And I capture "hover-menu"
    When I click the group chip
    Then the group menu has no Clean up, Close other groups or Close group
    And I capture "click-menu"

  Scenario: Right click opens the context menu and Close group closes the tabs
    Given the viewport is 1440x900
    And a Haiku session with one finished reply
    When I right click the group chip
    Then the group context menu has Move group left, Move group right, Clean up group, Close other groups and Close group
    And I capture "context-menu"
    When I choose "Close group" in the group context menu
    Then the group chip is gone
    And I capture "group-closed"

  Scenario: Phone keeps the tab switcher
    Given the viewport is 390x844
    And a Haiku session with one finished reply
    Then the phone shows the tab switcher and no group chip
    And the page has no horizontal scroll
    And I capture "switcher"
