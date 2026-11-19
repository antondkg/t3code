export const THREAD_WIDGET_BOOTSTRAP = `(function(){var value,listeners=new Set();window.t3Widget={get data(){return value;},onUpdate:function(fn){listeners.add(fn);if(value!==undefined)fn(value);return function(){listeners.delete(fn);};}};window.addEventListener("message",function(event){if(event.source!==window.parent||!event.data||event.data.type!=="t3-widget-data")return;value=event.data.data;listeners.forEach(function(fn){try{fn(value);}catch(error){console.error(error);}});});})();`;

export function threadWidgetDataMessage(data: unknown) {
  return { type: "t3-widget-data", data };
}
