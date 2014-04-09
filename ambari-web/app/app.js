/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Application bootstrapper
require('utils/ember_reopen');
var stringUtils = require('utils/string_utils');

module.exports = Em.Application.create({
  name: 'Ambari Web',
  rootElement: '#wrapper',

  store: DS.Store.create({
    revision: 4,
    adapter: DS.FixtureAdapter.create({
      simulateRemoteResponse: false
    })
  }),
  isAdmin: false,
  /**
   * return url prefix with number value of version of HDP stack
   */
  stackVersionURL:function(){
    var stackVersion = this.get('currentStackVersion') || this.get('defaultStackVersion');
    if(stackVersion.indexOf('HDPLocal') !== -1){
      return '/stacks/HDPLocal/version/' + stackVersion.replace(/HDPLocal-/g, '');
    }
    return '/stacks/HDP/version/' + stackVersion.replace(/HDP-/g, '');
  }.property('currentStackVersion'),
  
  /**
   * return url prefix with number value of version of HDP stack
   */
  stack2VersionURL:function(){
    var stackVersion = this.get('currentStackVersion') || this.get('defaultStackVersion');
    if(stackVersion.indexOf('HDPLocal') !== -1){
      return '/stacks2/HDPLocal/versions/' + stackVersion.replace(/HDPLocal-/g, '');
    }
    return '/stacks2/HDP/versions/' + stackVersion.replace(/HDP-/g, '');
  }.property('currentStackVersion'),

  falconServerURL: function () {
    var falconService = this.Service.find().findProperty('serviceName', 'FALCON');
    if (falconService) {
      return falconService.get('hostComponents').findProperty('componentName', 'FALCON_SERVER').get('host.hostName');
    }
  }.property().volatile(),

  clusterName: null,
  clockDistance:null, // server clock - client clock
  currentStackVersion: '',
  currentStackVersionNumber: function(){
    return this.get('currentStackVersion').replace(/HDP(Local)?-/, '');
  }.property('currentStackVersion'),
  isHadoop2Stack: function(){
    return (stringUtils.compareVersions(this.get('currentStackVersionNumber'), "2.0") === 1 ||
      stringUtils.compareVersions(this.get('currentStackVersionNumber'), "2.0") === 0)
  }.property('currentStackVersionNumber'),

  /**
   * If High Availability is enabled
   * Based on <code>clusterStatus.isInstalled</code>, stack version, <code>SNameNode</code> availability
   *
   * @type {Boolean}
   */
  isHaEnabled: function() {
    if (!this.get('isHadoop2Stack')) return false;
    return !this.HostComponent.find().someProperty('componentName', 'SECONDARY_NAMENODE');
  }.property('router.clusterController.isLoaded'),

  /**
   * List of disabled components for the current stack with related info.
   * Each element has followed structure:
   * @type {Em.Object}
   *   @property componentName {String} - name of the component
   *   @property properties {Object} - mapped properties by site files,
   *    for example:
   *      properties: { global_properties: [], site_properties: [], etc. }
   *   @property reviewConfigs {Ember.Object} - reference review_configs.js
   *
   * @type {Array}
   */
  stackDependedComponents: [],

  /**
   * Restore component data that was excluded from stack.
   *
   * @param component {Ember.Object} - #stackDependedComponents item
   */
  enableComponent: function(component) {
    var propertyFileNames = ['global_properties', 'site_properties'];
    var requirePrefix = this.get('isHadoop2Stack') ? 'data/HDP2/' : 'data/';
    // add properties
    propertyFileNames.forEach(function(fileName) {
      require(requirePrefix + fileName).configProperties = require(requirePrefix + fileName).configProperties.concat(component.get('properties.'+fileName));
    });
    var reviewConfigsService = require('data/review_configs')
      .findProperty('config_name', 'services').config_value
      .findProperty('service_name', component.get('serviceName'));
    reviewConfigsService.get('service_components').pushObject(component.get('reviewConfigs'));
  },
  /**
   * Disabling component. Remove related data from lists such as
   * properties, review configs, service components.
   *
   * @param component {Object} - stack service component
   *
   * @return {Ember.Object} - item of <code>stackDependedComponents</code> property
   */
  disableComponent: function(component) {
    var componentCopy, propertyFileNames;
    var service_configs = require('data/service_configs');
    propertyFileNames = ['global_properties', 'site_properties'];
    componentCopy = Em.Object.create({
      componentName: component.get('componentName'),
      serviceName: component.get('serviceName'),
      properties: {},
      reviewConfigs: {},
      configCategory: {}
    });

    var serviceConfigsCategoryName, requirePrefix, serviceConfig;
    // get service category name related to component
    serviceConfig = service_configs.findProperty('serviceName', component.get('serviceName'));
    serviceConfig.configCategories = serviceConfig.configCategories.filter(function(configCategory) {
      if (configCategory.get('hostComponentNames')) {
        serviceConfigsCategoryName = configCategory.get('name');
        if (configCategory.get('hostComponentNames').contains(component.get('componentName'))) {
          componentCopy.set('configCategory', configCategory);
        }
      }
      return true;
    });
    requirePrefix = this.get('isHadoop2Stack') ? 'data/HDP2/' : 'data/';
    var propertyObj = {};
    propertyFileNames.forEach(function(propertyFileName) {
      propertyObj[propertyFileName] = [];
    });
    // remove config properties related to this component
    propertyFileNames.forEach(function(propertyFileName) {
      var properties = require(requirePrefix + propertyFileName);
      properties.configProperties = properties.configProperties.filter(function(property) {
        if (property.category == serviceConfigsCategoryName) {
          propertyObj[propertyFileName].push(property);
          return false;
        } else {
          return true;
        }
      });
    });
    componentCopy.set('properties', propertyObj);
    // remove component from review configs
    var reviewConfigsService = require('data/review_configs')
      .findProperty('config_name', 'services').config_value
      .findProperty('service_name', component.get('serviceName'));
    reviewConfigsService.set('service_components', reviewConfigsService.get('service_components').filter(function (serviceComponent) {
      if (serviceComponent.get('component_name') != component.get('componentName')) {
        return true;
      } else {
        componentCopy.set('reviewConfigs', serviceComponent);
        return false;
      }
    }));
    return componentCopy;
  },
  /**
   * Resolve dependency in components. Check forbidden/allowed components and
   * remove/restore related data.
   */
  handleStackDependedComponents: function() {
    // need for unit testing and test mode
    if (this.get('handleStackDependencyTest') || this.testMode) return;
    var stackDependedComponents = [];
    var service_configs = require('data/service_configs');
    var stackServiceComponents = this.StackServiceComponent.find();
    if (!stackServiceComponents.mapProperty('componentName').length) {
       return;
    }
    // disable components
    service_configs.forEach(function(service){
      service.configCategories.forEach(function(serviceConfigCategory){
        var categoryComponents = serviceConfigCategory.get('hostComponentNames');
        if (categoryComponents && categoryComponents.length) {
          categoryComponents.forEach(function(categoryComponent) {
            var stackComponent = stackServiceComponents.findProperty('componentName',categoryComponent);
            if(!stackComponent && !this.get('stackDependedComponents').mapProperty('componentName').contains['categoryComponent'] ) {
              var _stackComponent = Ember.Object.create({
                componentName: categoryComponent,
                serviceName:service.serviceName
              });
              stackDependedComponents.push(this.disableComponent(_stackComponent));
            }
          },this);
        }
      },this);
    },this);
    // enable components
    if (this.get('stackDependedComponents').length > 0) {
      this.get('stackDependedComponents').forEach(function(component) {
        if (stackServiceComponents.findProperty('componentName',component.get('componentName'))) {
          this.enableComponent(component);
          stackDependedComponents = this.get('stackDependedComponents').removeObject(component);
        }
      }, this);
    }
    this.set('stackDependedComponents', this.get('stackDependedComponents').concat(stackDependedComponents));
  },

  /**
   * List of components with allowed action for them
   * @type {Em.Object}
   */
  components: function() {
    var self = this;
    return Ember.Object.create({
      allComponents:self.StackServiceComponent.find().mapProperty('componentName'),
      reassignable: self.StackServiceComponent.find().filterProperty('isReassignable',true).mapProperty('componentName'),
      restartable: self.StackServiceComponent.find().filterProperty('isRestartable',true).mapProperty('componentName'),
      deletable: self.StackServiceComponent.find().filterProperty('isDeletable',true).mapProperty('componentName'),
      rollinRestartAllowed: self.StackServiceComponent.find().filterProperty('isRollinRestartAllowed',true).mapProperty('componentName'),
      decommissionAllowed: self.StackServiceComponent.find().filterProperty('isDecommissionAllowed',true).mapProperty('componentName'),
      addableToHost: self.StackServiceComponent.find().filterProperty('isAddableToHost',true).mapProperty('componentName'),
      slaves: self.StackServiceComponent.find().filterProperty('isSlave',true).mapProperty('componentName'),
      masters: self.StackServiceComponent.find().filterProperty('isMaster',true).mapProperty('componentName'),
      clients: self.StackServiceComponent.find().filterProperty('isClient',true).mapProperty('componentName')
    })
  }.property()
});